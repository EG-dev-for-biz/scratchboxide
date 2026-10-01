/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_GLTF_SCENE_HPP
#define SCRATCHBOX_GLTF_SCENE_HPP

#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_jpeg.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace scratchbox {
namespace gltf {

using math::AABB;
using math::Mat4;
using math::Vec2;
using math::Vec3;
using math::Vec4;

struct SceneMaterial {
    Vec4 baseColorFactor{1.0f, 1.0f, 1.0f, 1.0f};
    float metallicFactor{1.0f};
    float roughnessFactor{1.0f};
    Vec3 emissiveFactor{0.0f, 0.0f, 0.0f};
    int baseColorImage{-1};
    int wrapS{10497};  // glTF sampler wrap mode: 10497 repeat, 33071 clamp, 33648 mirrored repeat
    int wrapT{10497};
    bool doubleSided{false};
    bool unlit{false};
};

struct SceneImage {
    std::string mimeType;
    bool decoded{false};
    std::string error;
    texture::ImageBuffer pixels;
};

/**
 * A flattened, render-ready glTF scene: every triangle primitive of every node instance,
 * transformed to world space and merged into one mesh with a per-triangle material index.
 * When a primitive has no material, the glTF default material is appended to `materials`.
 */
struct GltfScene {
    bool ok{false};
    std::string error;
    geometry::ScratchboxMesh mesh;
    std::vector<uint32_t> triangleMaterial;
    std::vector<SceneMaterial> materials;
    std::vector<SceneImage> images;
    AABB bounds;
    size_t primitiveCount{0};
    size_t nodeCount{0};
};

class GlbSceneReader {
public:
    static GltfScene readFile(const std::string& path) {
        std::ifstream file(path, std::ios::binary | std::ios::ate);
        if (!file.is_open()) {
            GltfScene scene;
            scene.error = "cannot open " + path;
            return scene;
        }
        std::streamsize size = file.tellg();
        file.seekg(0, std::ios::beg);
        std::vector<uint8_t> data(static_cast<size_t>(std::max<std::streamsize>(size, 0)));
        if (size <= 0 || !file.read(reinterpret_cast<char*>(data.data()), size)) {
            GltfScene scene;
            scene.error = "cannot read " + path;
            return scene;
        }
        return parse(data.data(), data.size());
    }

    static GltfScene parse(const uint8_t* data, size_t length) {
        GltfScene scene;
        if (!data || length < 20) {
            scene.error = "buffer too small for a GLB";
            return scene;
        }
        uint32_t magic = readU32(data), version = readU32(data + 4);
        if (magic != 0x46546C67 || version != 2) {
            scene.error = "not a glTF 2.0 binary (GLB) file";
            return scene;
        }
        uint32_t jsonLength = readU32(data + 12);
        if (readU32(data + 16) != 0x4E4F534A || 20 + static_cast<size_t>(jsonLength) > length) {
            scene.error = "GLB is missing its JSON chunk";
            return scene;
        }
        io::GlbJsonParser parser(reinterpret_cast<const char*>(data + 20), jsonLength);
        io::GlbJsonValue root = parser.parse();

        const uint8_t* bin = nullptr;
        size_t binLength = 0;
        size_t binHeader = 20 + static_cast<size_t>(jsonLength);
        if (binHeader + 8 <= length && readU32(data + binHeader + 4) == 0x004E4942) {
            bin = data + binHeader + 8;
            binLength = std::min<size_t>(readU32(data + binHeader), length - binHeader - 8);
        }

        Context ctx{root, bin, binLength};
        readMaterials(ctx, scene);
        readImages(ctx, scene);

        const auto& nodes = root["nodes"];
        scene.nodeCount = nodes.arr.size();
        std::vector<int> roots;
        int sceneIndex = root["scene"].asInt(0);
        const auto& scenes = root["scenes"];
        if (!scenes.arr.empty() && sceneIndex >= 0 && sceneIndex < static_cast<int>(scenes.arr.size())) {
            for (const auto& n : scenes[static_cast<size_t>(sceneIndex)]["nodes"].arr) roots.push_back(n.asInt(-1));
        } else {
            std::vector<bool> isChild(nodes.arr.size(), false);
            for (const auto& n : nodes.arr) {
                for (const auto& c : n["children"].arr) {
                    int ci = c.asInt(-1);
                    if (ci >= 0 && ci < static_cast<int>(isChild.size())) isChild[ci] = true;
                }
            }
            for (size_t i = 0; i < nodes.arr.size(); ++i) {
                if (!isChild[i]) roots.push_back(static_cast<int>(i));
            }
        }
        for (int r : roots) walkNode(ctx, scene, r, Mat4::identity(), 0);

        scene.bounds = scene.mesh.bounds;
        if (scene.mesh.indices.empty()) {
            scene.error = "GLB contains no triangle geometry";
            return scene;
        }
        scene.ok = true;
        return scene;
    }

private:
    struct Context {
        const io::GlbJsonValue& root;
        const uint8_t* bin;
        size_t binLength;
        int defaultMaterial{-1};
    };

    struct Accessor {
        const uint8_t* base{nullptr};
        size_t count{0};
        int components{0};
        int componentType{0};
        bool normalized{false};
        size_t stride{0};
        bool valid() const { return base != nullptr && count > 0; }
    };

    static uint32_t readU32(const uint8_t* p) {
        uint32_t v;
        std::memcpy(&v, p, 4);
        return v;
    }

    static int componentCount(const std::string& type) {
        if (type == "SCALAR") return 1;
        if (type == "VEC2") return 2;
        if (type == "VEC3") return 3;
        if (type == "VEC4") return 4;
        if (type == "MAT4") return 16;
        return 0;
    }

    static size_t componentSize(int componentType) {
        switch (componentType) {
            case 5120: case 5121: return 1;
            case 5122: case 5123: return 2;
            case 5125: case 5126: return 4;
            default: return 0;
        }
    }

    static Accessor accessor(const Context& ctx, int index) {
        Accessor a;
        const auto& accessors = ctx.root["accessors"];
        if (!ctx.bin || index < 0 || index >= static_cast<int>(accessors.arr.size())) return a;
        const auto& acc = accessors[static_cast<size_t>(index)];
        int viewIndex = acc["bufferView"].asInt(-1);
        const auto& views = ctx.root["bufferViews"];
        if (viewIndex < 0 || viewIndex >= static_cast<int>(views.arr.size())) return a;
        const auto& view = views[static_cast<size_t>(viewIndex)];
        if (view["buffer"].asInt(0) != 0) return a;

        a.componentType = acc["componentType"].asInt(0);
        a.components = componentCount(acc["type"].asString("SCALAR"));
        a.normalized = acc["normalized"].type == io::GlbJsonValue::Bool && acc["normalized"].b;
        a.count = acc["count"].asSizeT(0);
        size_t elementSize = componentSize(a.componentType) * static_cast<size_t>(a.components);
        a.stride = view["byteStride"].asSizeT(0);
        if (a.stride == 0) a.stride = elementSize;
        size_t offset = view["byteOffset"].asSizeT(0) + acc["byteOffset"].asSizeT(0);
        if (elementSize == 0 || a.count == 0 || offset + (a.count - 1) * a.stride + elementSize > ctx.binLength) {
            a.count = 0;
            return a;
        }
        a.base = ctx.bin + offset;
        return a;
    }

    static float component(const Accessor& a, size_t element, int c) {
        const uint8_t* p = a.base + element * a.stride + static_cast<size_t>(c) * componentSize(a.componentType);
        switch (a.componentType) {
            case 5126: { float f; std::memcpy(&f, p, 4); return f; }
            case 5121: return a.normalized ? p[0] / 255.0f : static_cast<float>(p[0]);
            case 5120: {
                auto v = static_cast<int8_t>(p[0]);
                return a.normalized ? std::max(v / 127.0f, -1.0f) : static_cast<float>(v);
            }
            case 5123: { uint16_t v; std::memcpy(&v, p, 2); return a.normalized ? v / 65535.0f : static_cast<float>(v); }
            case 5122: {
                int16_t v; std::memcpy(&v, p, 2);
                return a.normalized ? std::max(v / 32767.0f, -1.0f) : static_cast<float>(v);
            }
            case 5125: { uint32_t v; std::memcpy(&v, p, 4); return static_cast<float>(v); }
            default: return 0.0f;
        }
    }

    static uint32_t index(const Accessor& a, size_t element) {
        const uint8_t* p = a.base + element * a.stride;
        switch (a.componentType) {
            case 5121: return p[0];
            case 5123: { uint16_t v; std::memcpy(&v, p, 2); return v; }
            case 5125: { uint32_t v; std::memcpy(&v, p, 4); return v; }
            default: return 0;
        }
    }

    static void readMaterials(Context& ctx, GltfScene& scene) {
        const auto& textures = ctx.root["textures"];
        const auto& samplers = ctx.root["samplers"];
        for (const auto& m : ctx.root["materials"].arr) {
            SceneMaterial sm;
            const auto& pbr = m["pbrMetallicRoughness"];
            const auto& factor = pbr["baseColorFactor"];
            if (factor.arr.size() == 4) {
                sm.baseColorFactor = Vec4(factor[0].asFloat(1), factor[1].asFloat(1), factor[2].asFloat(1), factor[3].asFloat(1));
            }
            sm.metallicFactor = pbr["metallicFactor"].asFloat(1.0f);
            sm.roughnessFactor = pbr["roughnessFactor"].asFloat(1.0f);
            int textureIndex = pbr["baseColorTexture"]["index"].asInt(-1);
            if (textureIndex >= 0 && textureIndex < static_cast<int>(textures.arr.size())) {
                const auto& tex = textures[static_cast<size_t>(textureIndex)];
                sm.baseColorImage = tex["source"].asInt(-1);
                int samplerIndex = tex["sampler"].asInt(-1);
                if (samplerIndex >= 0 && samplerIndex < static_cast<int>(samplers.arr.size())) {
                    const auto& sampler = samplers[static_cast<size_t>(samplerIndex)];
                    sm.wrapS = sampler["wrapS"].asInt(10497);
                    sm.wrapT = sampler["wrapT"].asInt(10497);
                }
            }
            const auto& emissive = m["emissiveFactor"];
            if (emissive.arr.size() == 3) {
                sm.emissiveFactor = Vec3(emissive[0].asFloat(0), emissive[1].asFloat(0), emissive[2].asFloat(0));
            }
            sm.doubleSided = m["doubleSided"].type == io::GlbJsonValue::Bool && m["doubleSided"].b;
            sm.unlit = m["extensions"].has("KHR_materials_unlit");
            scene.materials.push_back(sm);
        }
    }

    static void readImages(const Context& ctx, GltfScene& scene) {
        const auto& views = ctx.root["bufferViews"];
        for (const auto& img : ctx.root["images"].arr) {
            SceneImage si;
            si.mimeType = img["mimeType"].asString("");
            int viewIndex = img["bufferView"].asInt(-1);
            if (viewIndex < 0 || viewIndex >= static_cast<int>(views.arr.size()) || !ctx.bin) {
                si.error = "image is not embedded in the GLB binary chunk";
                scene.images.push_back(std::move(si));
                continue;
            }
            const auto& view = views[static_cast<size_t>(viewIndex)];
            size_t offset = view["byteOffset"].asSizeT(0);
            size_t size = view["byteLength"].asSizeT(0);
            if (offset + size > ctx.binLength) {
                si.error = "image bufferView is out of range";
                scene.images.push_back(std::move(si));
                continue;
            }
            const uint8_t* bytes = ctx.bin + offset;
            bool isJpeg = si.mimeType == "image/jpeg" || (size > 2 && bytes[0] == 0xFF && bytes[1] == 0xD8);
            bool isPng = si.mimeType == "image/png" || (size > 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47);
            if (isJpeg) {
                auto decoded = jpeg::decode(bytes, size, jpeg::OutputFormat::Rgb);
                si.decoded = decoded.ok;
                si.error = decoded.error;
                si.pixels = std::move(decoded.image);
            } else if (isPng) {
                auto decoded = png::decode(bytes, size, png::OutputFormat::Rgb);
                si.decoded = decoded.ok;
                si.error = decoded.error;
                si.pixels = std::move(decoded.image);
            } else {
                si.error = "unsupported image type: " + (si.mimeType.empty() ? std::string("unknown") : si.mimeType);
            }
            scene.images.push_back(std::move(si));
        }
    }

    static Mat4 localMatrix(const io::GlbJsonValue& node) {
        const auto& matrix = node["matrix"];
        if (matrix.arr.size() == 16) {
            Mat4 m;
            for (size_t i = 0; i < 16; ++i) m.m[i] = matrix[i].asFloat(0.0f);
            return m;
        }
        Vec3 t(0, 0, 0), s(1, 1, 1);
        float qx = 0, qy = 0, qz = 0, qw = 1;
        const auto& tr = node["translation"];
        if (tr.arr.size() == 3) t = Vec3(tr[0].asFloat(0), tr[1].asFloat(0), tr[2].asFloat(0));
        const auto& sc = node["scale"];
        if (sc.arr.size() == 3) s = Vec3(sc[0].asFloat(1), sc[1].asFloat(1), sc[2].asFloat(1));
        const auto& rot = node["rotation"];
        if (rot.arr.size() == 4) {
            qx = rot[0].asFloat(0); qy = rot[1].asFloat(0); qz = rot[2].asFloat(0); qw = rot[3].asFloat(1);
        }
        float xx = qx * qx, yy = qy * qy, zz = qz * qz;
        float xy = qx * qy, xz = qx * qz, yz = qy * qz;
        float wx = qw * qx, wy = qw * qy, wz = qw * qz;
        Mat4 m = Mat4::identity();
        m.m[0] = (1 - 2 * (yy + zz)) * s.x; m.m[1] = 2 * (xy + wz) * s.x;       m.m[2] = 2 * (xz - wy) * s.x;
        m.m[4] = 2 * (xy - wz) * s.y;       m.m[5] = (1 - 2 * (xx + zz)) * s.y; m.m[6] = 2 * (yz + wx) * s.y;
        m.m[8] = 2 * (xz + wy) * s.z;       m.m[9] = 2 * (yz - wx) * s.z;       m.m[10] = (1 - 2 * (xx + yy)) * s.z;
        m.m[12] = t.x; m.m[13] = t.y; m.m[14] = t.z;
        return m;
    }

    // Inverse-transpose of the upper 3x3 of a column-major matrix, returned as a column-major Mat4.
    static Mat4 normalMatrix(const Mat4& w) {
        const float a = w.m[0], b = w.m[4], c = w.m[8];
        const float d = w.m[1], e = w.m[5], f = w.m[9];
        const float g = w.m[2], h = w.m[6], i = w.m[10];
        float det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        Mat4 n = Mat4::identity();
        if (std::abs(det) < 1e-20f) return n;
        float inv = 1.0f / det;
        // Row-major inverse entries, placed transposed into a column-major layout.
        n.m[0] = (e * i - f * h) * inv; n.m[4] = (f * g - d * i) * inv; n.m[8]  = (d * h - e * g) * inv;
        n.m[1] = (c * h - b * i) * inv; n.m[5] = (a * i - c * g) * inv; n.m[9]  = (b * g - a * h) * inv;
        n.m[2] = (b * f - c * e) * inv; n.m[6] = (c * d - a * f) * inv; n.m[10] = (a * e - b * d) * inv;
        return n;
    }

    static void walkNode(Context& ctx, GltfScene& scene, int nodeIndex, const Mat4& parent, int depth) {
        const auto& nodes = ctx.root["nodes"];
        if (nodeIndex < 0 || nodeIndex >= static_cast<int>(nodes.arr.size()) || depth > 64) return;
        const auto& node = nodes[static_cast<size_t>(nodeIndex)];
        Mat4 world = parent * localMatrix(node);
        int meshIndex = node["mesh"].asInt(-1);
        const auto& meshes = ctx.root["meshes"];
        if (meshIndex >= 0 && meshIndex < static_cast<int>(meshes.arr.size())) {
            Mat4 normalXf = normalMatrix(world);
            for (const auto& prim : meshes[static_cast<size_t>(meshIndex)]["primitives"].arr) {
                appendPrimitive(ctx, scene, prim, world, normalXf);
            }
        }
        for (const auto& child : node["children"].arr) walkNode(ctx, scene, child.asInt(-1), world, depth + 1);
    }

    static void appendPrimitive(Context& ctx, GltfScene& scene, const io::GlbJsonValue& prim, const Mat4& world, const Mat4& normalXf) {
        if (prim["mode"].asInt(4) != 4) return;
        const auto& attrs = prim["attributes"];
        Accessor pos = accessor(ctx, attrs["POSITION"].asInt(-1));
        if (!pos.valid() || pos.components != 3) return;
        Accessor nrm = accessor(ctx, attrs["NORMAL"].asInt(-1));
        Accessor uv = accessor(ctx, attrs["TEXCOORD_0"].asInt(-1));
        Accessor col = accessor(ctx, attrs["COLOR_0"].asInt(-1));
        Accessor idx = accessor(ctx, prim["indices"].asInt(-1));
        const bool hasNormals = nrm.valid() && nrm.components == 3 && nrm.count == pos.count;
        const bool hasUv = uv.valid() && uv.components == 2 && uv.count == pos.count;
        const bool hasColor = col.valid() && (col.components == 3 || col.components == 4) && col.count == pos.count;

        int materialIndex = prim["material"].asInt(-1);
        if (materialIndex < 0 || materialIndex >= static_cast<int>(scene.materials.size())) {
            if (ctx.defaultMaterial < 0) {
                ctx.defaultMaterial = static_cast<int>(scene.materials.size());
                scene.materials.push_back(SceneMaterial{});
            }
            materialIndex = ctx.defaultMaterial;
        }

        const uint32_t base = static_cast<uint32_t>(scene.mesh.vertices.size());
        for (size_t v = 0; v < pos.count; ++v) {
            geometry::Vertex vert;
            vert.position = world.transformPoint(Vec3(component(pos, v, 0), component(pos, v, 1), component(pos, v, 2)));
            if (hasNormals) {
                vert.normal = normalXf.transformDirection(Vec3(component(nrm, v, 0), component(nrm, v, 1), component(nrm, v, 2))).normalized();
            } else {
                vert.normal = Vec3(0, 0, 0);
            }
            if (hasUv) vert.uv = Vec2(component(uv, v, 0), component(uv, v, 1));
            if (hasColor) {
                float r = component(col, v, 0);
                float g = component(col, v, 1);
                float b = component(col, v, 2);
                float a = col.components == 4 ? component(col, v, 3) : 1.0f;
                vert.color = Vec4(r, g, b, a);
            }
            scene.mesh.addVertex(vert);
        }

        const size_t firstIndex = scene.mesh.indices.size();
        const size_t indexCount = idx.valid() ? idx.count : pos.count;
        for (size_t i = 0; i + 2 < indexCount; i += 3) {
            uint32_t a = idx.valid() ? index(idx, i) : static_cast<uint32_t>(i);
            uint32_t b = idx.valid() ? index(idx, i + 1) : static_cast<uint32_t>(i + 1);
            uint32_t c = idx.valid() ? index(idx, i + 2) : static_cast<uint32_t>(i + 2);
            if (a >= pos.count || b >= pos.count || c >= pos.count) continue;
            scene.mesh.addTriangle(base + a, base + b, base + c);
            scene.triangleMaterial.push_back(static_cast<uint32_t>(materialIndex));
        }

        if (!hasNormals) {
            for (size_t i = firstIndex; i + 2 < scene.mesh.indices.size(); i += 3) {
                auto& v0 = scene.mesh.vertices[scene.mesh.indices[i]];
                auto& v1 = scene.mesh.vertices[scene.mesh.indices[i + 1]];
                auto& v2 = scene.mesh.vertices[scene.mesh.indices[i + 2]];
                Vec3 areaNormal = (v1.position - v0.position).cross(v2.position - v0.position);
                v0.normal += areaNormal;
                v1.normal += areaNormal;
                v2.normal += areaNormal;
            }
            for (size_t v = base; v < scene.mesh.vertices.size(); ++v) {
                Vec3 n = scene.mesh.vertices[v].normal.normalized();
                scene.mesh.vertices[v].normal = n.lengthSquared() > 0.5f ? n : Vec3(0, 1, 0);
            }
        }
        ++scene.primitiveCount;
    }
};

} // namespace gltf
} // namespace scratchbox

#endif // SCRATCHBOX_GLTF_SCENE_HPP
