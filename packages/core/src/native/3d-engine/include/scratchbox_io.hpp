/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_IO_HPP
#define SCRATCHBOX_IO_HPP

#include "scratchbox_geometry.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_skinning.hpp"
#include "scratchbox_lighting.hpp"
#include <algorithm>
#include <fstream>
#include <sstream>
#include <vector>
#include <string>
#include <cstring>
#include <cstdint>
#include <iostream>
#include <array>

namespace scratchbox {
namespace io {

using geometry::ScratchboxMesh;
using geometry::Mesh;
using geometry::Vertex;

/**
 * Computes a glTF rotation quaternion that rotates default light axis (0, 0, -1) to target direction.
 */
inline std::array<float, 4> directionToGltfQuat(const math::Vec3& dir) {
    math::Vec3 d = dir.normalized();
    math::Vec3 v1(0.0f, 0.0f, -1.0f);
    float dot = v1.dot(d);
    if (dot > 0.999999f) {
        return {0.0f, 0.0f, 0.0f, 1.0f};
    }
    if (dot < -0.999999f) {
        return {0.0f, 1.0f, 0.0f, 0.0f};
    }
    math::Vec3 axis = v1.cross(d);
    float w = 1.0f + dot;
    float len = std::sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z + w * w);
    return {axis.x / len, axis.y / len, axis.z / len, w / len};
}

// Base64 helper for streaming chunks over stdout
inline std::string base64Encode(const uint8_t* data, size_t length) {
    static const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve(((length + 2) / 3) * 4);

    for (size_t i = 0; i < length; i += 3) {
        uint32_t b = (data[i] << 16) |
                     ((i + 1 < length ? data[i + 1] : 0) << 8) |
                     (i + 2 < length ? data[i + 2] : 0);

        result.push_back(chars[(b >> 18) & 63]);
        result.push_back(chars[(b >> 12) & 63]);
        result.push_back(i + 1 < length ? chars[(b >> 6) & 63] : '=');
        result.push_back(i + 2 < length ? chars[b & 63] : '=');
    }

    return result;
}

enum class TextureUsage {
    BASE_COLOR,
    METALLIC_ROUGHNESS,
    NORMAL,
    OCCLUSION,
    EMISSIVE,
    ORM
};

struct EmbeddedTexture {
    std::string name;
    std::string mimeType{"image/png"};
    std::vector<uint8_t> data;
    TextureUsage usage{TextureUsage::BASE_COLOR};
    float scaleU{1.0f};
    float scaleV{1.0f};
    float offsetU{0.0f};
    float offsetV{0.0f};
    int materialIndex{0};
    std::string targetMaterialName{""};
};

struct InstanceTransform {
    math::Vec3 position{0.0f, 0.0f, 0.0f};
    math::Vec3 scale{1.0f, 1.0f, 1.0f};
    math::Quat rotation{0.0f, 0.0f, 0.0f, 1.0f};
};

// ============================================================================
// Zero-Dependency glTF 2.0 Binary (.glb) Writer
// ============================================================================
class GlbWriter {
public:
    static std::vector<uint8_t> writeGlb(const ScratchboxMesh& mesh, const std::vector<EmbeddedTexture>& textures = {}, const std::vector<lighting::Light>& lights = {}) {
        return serializeToGlb(mesh, textures, lights);
    }

    static std::vector<uint8_t> writeGlb(const Mesh& mesh, const std::vector<EmbeddedTexture>& textures = {}, const std::vector<lighting::Light>& lights = {}) {
        return serializeToGlb(mesh.toScratchboxMesh(), textures, lights);
    }

    static std::vector<uint8_t> serializeToGlb(const Mesh& mesh, const std::vector<EmbeddedTexture>& textures = {}, const std::vector<lighting::Light>& lights = {}) {
        return serializeToGlb(mesh.toScratchboxMesh(), textures, lights);
    }

    static std::vector<uint8_t> serializeToGlb(const ScratchboxMesh& mesh, const std::vector<EmbeddedTexture>& textures = {}, const std::vector<lighting::Light>& lights = {}) {
        if (mesh.vertices.empty()) return {};

        // 1. Pack binary buffer (BIN chunk)
        // Order: Indices (uint32), Positions (vec3 float), Normals (vec3 float), UVs (vec2 float), Colors (vec4 float), Tangents (vec4 float), Textures (bytes)
        size_t indexBytes = mesh.indices.size() * sizeof(uint32_t);
        size_t posBytes = mesh.vertices.size() * 3 * sizeof(float);
        size_t normBytes = mesh.vertices.size() * 3 * sizeof(float);
        size_t uvBytes = mesh.vertices.size() * 2 * sizeof(float);
        size_t colorBytes = mesh.vertices.size() * 4 * sizeof(float);
        size_t tangentBytes = mesh.vertices.size() * 4 * sizeof(float);

        size_t currentOffset = indexBytes + posBytes + normBytes + uvBytes + colorBytes + tangentBytes;
        struct TexBv {
            size_t offset;
            size_t length;
        };
        std::vector<TexBv> texBvs;
        for (const auto& tex : textures) {
            size_t pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            texBvs.push_back({currentOffset, tex.data.size()});
            currentOffset += tex.data.size();
        }

        size_t binPadding = (4 - (currentOffset % 4)) % 4;
        size_t binChunkLength = currentOffset + binPadding;

        std::vector<uint8_t> binData(binChunkLength, 0);
        uint8_t* ptr = binData.data();

        // Copy indices
        size_t indexOffset = 0;
        std::memcpy(ptr, mesh.indices.data(), indexBytes);
        ptr += indexBytes;

        // Copy positions
        size_t posOffset = indexOffset + indexBytes;
        std::vector<float> posBuffer;
        posBuffer.reserve(mesh.vertices.size() * 3);
        float minX = 1e9f, minY = 1e9f, minZ = 1e9f;
        float maxX = -1e9f, maxY = -1e9f, maxZ = -1e9f;

        for (const auto& v : mesh.vertices) {
            posBuffer.push_back(v.position.x);
            posBuffer.push_back(v.position.y);
            posBuffer.push_back(v.position.z);
            minX = std::min(minX, v.position.x);
            minY = std::min(minY, v.position.y);
            minZ = std::min(minZ, v.position.z);
            maxX = std::max(maxX, v.position.x);
            maxY = std::max(maxY, v.position.y);
            maxZ = std::max(maxZ, v.position.z);
        }
        std::memcpy(ptr, posBuffer.data(), posBytes);
        ptr += posBytes;

        // Copy normals
        size_t normOffset = posOffset + posBytes;
        std::vector<float> normBuffer;
        normBuffer.reserve(mesh.vertices.size() * 3);
        for (const auto& v : mesh.vertices) {
            normBuffer.push_back(v.normal.x);
            normBuffer.push_back(v.normal.y);
            normBuffer.push_back(v.normal.z);
        }
        std::memcpy(ptr, normBuffer.data(), normBytes);
        ptr += normBytes;

        // Copy UVs
        size_t uvOffset = normOffset + normBytes;
        std::vector<float> uvBuffer;
        uvBuffer.reserve(mesh.vertices.size() * 2);
        for (const auto& v : mesh.vertices) {
            uvBuffer.push_back(v.uv.x);
            uvBuffer.push_back(v.uv.y);
        }
        std::memcpy(ptr, uvBuffer.data(), uvBytes);
        ptr += uvBytes;

        // Copy Colors (RGBA VEC4)
        size_t colorOffset = uvOffset + uvBytes;
        std::vector<float> colorBuffer;
        colorBuffer.reserve(mesh.vertices.size() * 4);
        for (const auto& v : mesh.vertices) {
            colorBuffer.push_back(v.color.x);
            colorBuffer.push_back(v.color.y);
            colorBuffer.push_back(v.color.z);
            colorBuffer.push_back(v.color.w);
        }
        std::memcpy(ptr, colorBuffer.data(), colorBytes);
        ptr += colorBytes;

        // Copy Tangents (VEC4 float: x, y, z, handedness)
        size_t tangentOffset = colorOffset + colorBytes;
        std::vector<float> tangentBuffer;
        tangentBuffer.reserve(mesh.vertices.size() * 4);
        for (const auto& v : mesh.vertices) {
            tangentBuffer.push_back(v.tangent.x);
            tangentBuffer.push_back(v.tangent.y);
            tangentBuffer.push_back(v.tangent.z);
            tangentBuffer.push_back(v.tangent.w);
        }
        std::memcpy(ptr, tangentBuffer.data(), tangentBytes);

        // Copy embedded textures
        for (size_t i = 0; i < textures.size(); ++i) {
            if (!textures[i].data.empty()) {
                std::memcpy(binData.data() + texBvs[i].offset, textures[i].data.data(), texBvs[i].length);
            }
        }

        // Inspect PBR Next extensions
        std::vector<std::string> extensionsUsed;
        std::stringstream extJson;
        bool hasExtensions = false;

        int baseColorTexIdx = -1;
        int mrTexIdx = -1;
        int normalTexIdx = -1;
        int occTexIdx = -1;
        int emissiveTexIdx = -1;
        bool hasWebp = false;
        bool hasTextureTransform = false;
        for (size_t i = 0; i < textures.size(); ++i) {
            if (textures[i].mimeType == "image/webp") {
                hasWebp = true;
            }
            if (textures[i].usage == TextureUsage::BASE_COLOR && baseColorTexIdx == -1) baseColorTexIdx = static_cast<int>(i);
            else if ((textures[i].usage == TextureUsage::METALLIC_ROUGHNESS || textures[i].usage == TextureUsage::ORM) && mrTexIdx == -1) mrTexIdx = static_cast<int>(i);
            else if (textures[i].usage == TextureUsage::NORMAL && normalTexIdx == -1) normalTexIdx = static_cast<int>(i);
            else if (textures[i].usage == TextureUsage::OCCLUSION && occTexIdx == -1) occTexIdx = static_cast<int>(i);
            else if (textures[i].usage == TextureUsage::EMISSIVE && emissiveTexIdx == -1) emissiveTexIdx = static_cast<int>(i);

            if (textures[i].usage == TextureUsage::ORM && occTexIdx == -1) {
                occTexIdx = static_cast<int>(i);
            }

            if (std::abs(textures[i].scaleU - 1.0f) > 1e-4f || std::abs(textures[i].scaleV - 1.0f) > 1e-4f ||
                std::abs(textures[i].offsetU) > 1e-4f || std::abs(textures[i].offsetV) > 1e-4f) {
                hasTextureTransform = true;
            }
        }

        if (hasWebp) {
            extensionsUsed.push_back("EXT_texture_webp");
        }

        if (hasTextureTransform) {
            extensionsUsed.push_back("KHR_texture_transform");
        }

        if (mesh.material.clearcoatFactor > 0.0f) {
            extensionsUsed.push_back("KHR_materials_clearcoat");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_clearcoat\":{\"clearcoatFactor\":" << mesh.material.clearcoatFactor
                    << ",\"clearcoatRoughnessFactor\":" << mesh.material.clearcoatRoughnessFactor << "}";
            hasExtensions = true;
        }

        if (mesh.material.transmissionFactor > 0.0f) {
            extensionsUsed.push_back("KHR_materials_transmission");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_transmission\":{\"transmissionFactor\":" << mesh.material.transmissionFactor << "}";
            hasExtensions = true;
        }

        if (std::abs(mesh.material.ior - 1.5f) > 0.001f || mesh.material.transmissionFactor > 0.0f) {
            extensionsUsed.push_back("KHR_materials_ior");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_ior\":{\"ior\":" << mesh.material.ior << "}";
            hasExtensions = true;
        }

        if (mesh.material.thicknessFactor > 0.0f) {
            extensionsUsed.push_back("KHR_materials_volume");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_volume\":{\"thicknessFactor\":" << mesh.material.thicknessFactor
                    << ",\"attenuationDistance\":" << mesh.material.attenuationDistance
                    << ",\"attenuationColor\":[" << mesh.material.attenuationColor.x << "," << mesh.material.attenuationColor.y << "," << mesh.material.attenuationColor.z << "]}";
            hasExtensions = true;
        }

        if (mesh.material.sheenColorFactor.lengthSq() > 0.0001f) {
            extensionsUsed.push_back("KHR_materials_sheen");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_sheen\":{\"sheenColorFactor\":[" << mesh.material.sheenColorFactor.x << "," << mesh.material.sheenColorFactor.y << "," << mesh.material.sheenColorFactor.z << "]"
                    << ",\"sheenRoughnessFactor\":" << mesh.material.sheenRoughnessFactor << "}";
            hasExtensions = true;
        }

        if (std::abs(mesh.material.anisotropyStrength) > 0.01f) {
            extensionsUsed.push_back("KHR_materials_anisotropy");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_anisotropy\":{\"anisotropyStrength\":" << mesh.material.anisotropyStrength
                    << ",\"anisotropyRotation\":" << mesh.material.anisotropyRotation << "}";
            hasExtensions = true;
        }

        if (mesh.material.iridescenceFactor > 0.0f) {
            extensionsUsed.push_back("KHR_materials_iridescence");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_iridescence\":{\"iridescenceFactor\":" << mesh.material.iridescenceFactor
                    << ",\"iridescenceIor\":" << mesh.material.iridescenceIor
                    << ",\"iridescenceThicknessMinimum\":" << mesh.material.iridescenceThicknessMin
                    << ",\"iridescenceThicknessMaximum\":" << mesh.material.iridescenceThicknessMax << "}";
            hasExtensions = true;
        }

        if (mesh.material.emissiveStrength > 1.001f) {
            extensionsUsed.push_back("KHR_materials_emissive_strength");
            if (hasExtensions) extJson << ",";
            extJson << "\"KHR_materials_emissive_strength\":{\"emissiveStrength\":" << mesh.material.emissiveStrength << "}";
            hasExtensions = true;
        }

        auto appendTexInfo = [&](int texIdx) {
            std::stringstream ts;
            ts << "{\"index\":" << texIdx;
            const auto& t = textures[texIdx];
            if (std::abs(t.scaleU - 1.0f) > 1e-4f || std::abs(t.scaleV - 1.0f) > 1e-4f ||
                std::abs(t.offsetU) > 1e-4f || std::abs(t.offsetV) > 1e-4f) {
                ts << ",\"extensions\":{\"KHR_texture_transform\":{\"scale\":[" << t.scaleU << "," << t.scaleV
                   << "],\"offset\":[" << t.offsetU << "," << t.offsetV << "]}}";
            }
            ts << "}";
            return ts.str();
        };

        std::stringstream rootExtJson;
        bool hasRootExtensions = false;
        if (!lights.empty()) {
            extensionsUsed.push_back("KHR_lights_punctual");
            rootExtJson << "\"KHR_lights_punctual\":{\"lights\":[";
            for (size_t i = 0; i < lights.size(); ++i) {
                const auto& l = lights[i];
                std::string typeStr = "point";
                if (l.type == lighting::LightType::DIRECTIONAL) typeStr = "directional";
                else if (l.type == lighting::LightType::SPOT) typeStr = "spot";

                rootExtJson << "{\"name\":\"" << l.name << "\",\"type\":\"" << typeStr << "\","
                            << "\"color\":[" << l.color.x << "," << l.color.y << "," << l.color.z << "],"
                            << "\"intensity\":" << l.intensity;
                if (l.type != lighting::LightType::DIRECTIONAL && l.range > 0.0f) {
                    rootExtJson << ",\"range\":" << l.range;
                }
                if (l.type == lighting::LightType::SPOT) {
                    rootExtJson << ",\"spot\":{\"innerConeAngle\":" << l.innerConeAngle
                                << ",\"outerConeAngle\":" << l.outerConeAngle << "}";
                }
                rootExtJson << "}";
                if (i + 1 < lights.size()) rootExtJson << ",";
            }
            rootExtJson << "]}";
            hasRootExtensions = true;
        }

        // 2. Build JSON chunk with Photorealistic PBR Material, COLOR_0 & TANGENT Accessors
        std::stringstream ss;
        ss << "{"
           << "\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox Astro C++ Engine\"},";
        if (!extensionsUsed.empty()) {
            ss << "\"extensionsUsed\":[";
            for (size_t i = 0; i < extensionsUsed.size(); ++i) {
                ss << "\"" << extensionsUsed[i] << "\"";
                if (i + 1 < extensionsUsed.size()) ss << ",";
            }
            ss << "],";
        }
        ss << "\"scene\":0,"
           << "\"scenes\":[{\"nodes\":[";
        ss << "0";
        for (size_t i = 0; i < lights.size(); ++i) {
            ss << "," << (1 + i);
        }
        ss << "]}],"
           << "\"nodes\":[{\"mesh\":0,\"name\":\"" << mesh.name << "\"}";
        for (size_t i = 0; i < lights.size(); ++i) {
            const auto& l = lights[i];
            auto q = directionToGltfQuat(l.direction);
            ss << ",{\"name\":\"" << l.name << "\",\"translation\":["
               << l.position.x << "," << l.position.y << "," << l.position.z << "]";
            if (l.type == lighting::LightType::DIRECTIONAL || l.type == lighting::LightType::SPOT) {
                ss << ",\"rotation\":[" << q[0] << "," << q[1] << "," << q[2] << "," << q[3] << "]";
            }
            ss << ",\"extensions\":{\"KHR_lights_punctual\":{\"light\":" << i << "}}}";
        }
        ss << "],"
           << "\"meshes\":[{\"name\":\"" << mesh.name << "\",\"primitives\":[{"
           << "\"attributes\":{\"POSITION\":1,\"NORMAL\":2,\"TEXCOORD_0\":3,\"COLOR_0\":4,\"TANGENT\":5},"
           << "\"indices\":0,"
           << "\"material\":0"
           << "}]}],"
           << "\"materials\":[{"
           << "\"name\":\"" << mesh.material.name << "\","
           << "\"pbrMetallicRoughness\":{"
           << "\"baseColorFactor\":[" << mesh.material.baseColorFactor.x << "," << mesh.material.baseColorFactor.y << "," << mesh.material.baseColorFactor.z << "," << mesh.material.baseColorFactor.w << "],"
           << "\"metallicFactor\":" << mesh.material.metallicFactor << ","
           << "\"roughnessFactor\":" << mesh.material.roughnessFactor;
        if (baseColorTexIdx >= 0) {
            ss << ",\"baseColorTexture\":" << appendTexInfo(baseColorTexIdx);
        }
        if (mrTexIdx >= 0) {
            ss << ",\"metallicRoughnessTexture\":" << appendTexInfo(mrTexIdx);
        }
        ss << "},"
           << "\"emissiveFactor\":[" << mesh.material.emissiveFactor.x << "," << mesh.material.emissiveFactor.y << "," << mesh.material.emissiveFactor.z << "],";
        if (normalTexIdx >= 0) {
            ss << "\"normalTexture\":" << appendTexInfo(normalTexIdx) << ",";
        }
        if (occTexIdx >= 0) {
            ss << "\"occlusionTexture\":" << appendTexInfo(occTexIdx) << ",";
        }
        if (emissiveTexIdx >= 0) {
            ss << "\"emissiveTexture\":" << appendTexInfo(emissiveTexIdx) << ",";
        }
        ss << "\"doubleSided\":" << (mesh.material.doubleSided ? "true" : "false");
        if (mesh.material.alphaMode != "OPAQUE") {
            ss << ",\"alphaMode\":\"" << mesh.material.alphaMode << "\"";
            if (mesh.material.alphaMode == "MASK") {
                ss << ",\"alphaCutoff\":" << mesh.material.alphaCutoff;
            }
        }
        if (hasExtensions) {
            ss << ",\"extensions\":{" << extJson.str() << "}";
        }
        ss << "}],"
           << "\"accessors\":["
           << "{\"bufferView\":0,\"byteOffset\":0,\"componentType\":5125,\"count\":" << mesh.indices.size() << ",\"type\":\"SCALAR\"},"
           << "{\"bufferView\":1,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC3\",\"min\":[" << minX << "," << minY << "," << minZ << "],\"max\":[" << maxX << "," << maxY << "," << maxZ << "]},"
           << "{\"bufferView\":2,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC3\"},"
           << "{\"bufferView\":3,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC2\"},"
           << "{\"bufferView\":4,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":5,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"}"
           << "],"
           << "\"bufferViews\":["
           << "{\"buffer\":0,\"byteOffset\":" << indexOffset << ",\"byteLength\":" << indexBytes << ",\"target\":34963},"
           << "{\"buffer\":0,\"byteOffset\":" << posOffset << ",\"byteLength\":" << posBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << normOffset << ",\"byteLength\":" << normBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << uvOffset << ",\"byteLength\":" << uvBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << colorOffset << ",\"byteLength\":" << colorBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << tangentOffset << ",\"byteLength\":" << tangentBytes << ",\"target\":34962}";
        for (size_t i = 0; i < textures.size(); ++i) {
            ss << ",{\"buffer\":0,\"byteOffset\":" << texBvs[i].offset << ",\"byteLength\":" << texBvs[i].length << "}";
        }
        ss << "]";

        if (!textures.empty()) {
            ss << ",\"samplers\":[{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":10497,\"wrapT\":10497}]";
            ss << ",\"images\":[";
            for (size_t i = 0; i < textures.size(); ++i) {
                ss << "{\"bufferView\":" << (6 + i) << ",\"mimeType\":\"" << textures[i].mimeType << "\"}";
                if (i + 1 < textures.size()) ss << ",";
            }
            ss << "]";
            ss << ",\"textures\":[";
            for (size_t i = 0; i < textures.size(); ++i) {
                ss << "{\"sampler\":0,\"source\":" << i;
                if (textures[i].mimeType == "image/webp") {
                    ss << ",\"extensions\":{\"EXT_texture_webp\":{\"source\":" << i << "}}";
                }
                ss << "}";
                if (i + 1 < textures.size()) ss << ",";
            }
            ss << "]";
        }

        ss << ",\"buffers\":[{\"byteLength\":" << binChunkLength << "}]";
        if (hasRootExtensions) {
            ss << ",\"extensions\":{" << rootExtJson.str() << "}";
        }
        ss << "}";

        std::string jsonStr = ss.str();
        size_t jsonPadding = (4 - (jsonStr.size() % 4)) % 4;
        jsonStr.append(jsonPadding, ' '); // glTF JSON padding must be space (0x20)

        uint32_t jsonChunkLength = static_cast<uint32_t>(jsonStr.size());
        uint32_t totalLength = 12 + 8 + jsonChunkLength + 8 + static_cast<uint32_t>(binChunkLength);

        // 3. Assemble binary container
        std::vector<uint8_t> glb(totalLength);
        uint8_t* out = glb.data();

        // 12-byte header
        uint32_t magic = 0x46546C67; // "glTF"
        uint32_t version = 2;
        std::memcpy(out + 0, &magic, 4);
        std::memcpy(out + 4, &version, 4);
        std::memcpy(out + 8, &totalLength, 4);
        out += 12;

        // JSON Chunk header
        uint32_t jsonType = 0x4E4F534A; // "JSON"
        std::memcpy(out + 0, &jsonChunkLength, 4);
        std::memcpy(out + 4, &jsonType, 4);
        out += 8;
        std::memcpy(out, jsonStr.data(), jsonChunkLength);
        out += jsonChunkLength;

        // BIN Chunk header
        uint32_t binType = 0x004E4942; // "BIN\0"
        uint32_t binLen = static_cast<uint32_t>(binChunkLength);
        std::memcpy(out + 0, &binLen, 4);
        std::memcpy(out + 4, &binType, 4);
        out += 8;
        std::memcpy(out, binData.data(), binChunkLength);

        return glb;
    }

    static std::vector<uint8_t> serializeMultiMeshToGlb(
        const std::vector<ScratchboxMesh>& inputMeshes,
        const std::vector<EmbeddedTexture>& textures = {},
        const std::vector<lighting::Light>& lights = {}
    ) {
        // Filter out empty meshes
        std::vector<ScratchboxMesh> subMeshes;
        for (const auto& m : inputMeshes) {
            if (!m.vertices.empty()) {
                subMeshes.push_back(m);
            }
        }
        if (subMeshes.empty()) return {};

        size_t numMeshes = subMeshes.size();

        // 1. Compute binary layout for all meshes
        struct MeshOffsets {
            size_t indexOffset{0}, indexBytes{0}, indexCount{0};
            size_t posOffset{0}, posBytes{0}, vertCount{0};
            size_t normOffset{0}, normBytes{0};
            size_t uvOffset{0}, uvBytes{0};
            size_t colorOffset{0}, colorBytes{0};
            size_t tangentOffset{0}, tangentBytes{0};
            float minX{0}, minY{0}, minZ{0};
            float maxX{0}, maxY{0}, maxZ{0};
        };

        std::vector<MeshOffsets> meshOffsets(numMeshes);
        size_t currentOffset = 0;

        for (size_t m = 0; m < numMeshes; ++m) {
            const auto& mesh = subMeshes[m];
            auto& mo = meshOffsets[m];

            mo.indexCount = mesh.indices.size();
            mo.vertCount = mesh.vertices.size();
            mo.indexBytes = mo.indexCount * sizeof(uint32_t);
            mo.posBytes = mo.vertCount * 3 * sizeof(float);
            mo.normBytes = mo.vertCount * 3 * sizeof(float);
            mo.uvBytes = mo.vertCount * 2 * sizeof(float);
            mo.colorBytes = mo.vertCount * 4 * sizeof(float);
            mo.tangentBytes = mo.vertCount * 4 * sizeof(float);

            size_t pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            mo.indexOffset = currentOffset;
            currentOffset += mo.indexBytes;

            pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            mo.posOffset = currentOffset;
            currentOffset += mo.posBytes;

            pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            mo.normOffset = currentOffset;
            currentOffset += mo.normBytes;

            pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            mo.uvOffset = currentOffset;
            currentOffset += mo.uvBytes;

            pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            mo.colorOffset = currentOffset;
            currentOffset += mo.colorBytes;

            pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            mo.tangentOffset = currentOffset;
            currentOffset += mo.tangentBytes;

            mo.minX = 1e9f; mo.minY = 1e9f; mo.minZ = 1e9f;
            mo.maxX = -1e9f; mo.maxY = -1e9f; mo.maxZ = -1e9f;
            for (const auto& v : mesh.vertices) {
                mo.minX = std::min(mo.minX, v.position.x);
                mo.minY = std::min(mo.minY, v.position.y);
                mo.minZ = std::min(mo.minZ, v.position.z);
                mo.maxX = std::max(mo.maxX, v.position.x);
                mo.maxY = std::max(mo.maxY, v.position.y);
                mo.maxZ = std::max(mo.maxZ, v.position.z);
            }
        }

        struct TexBv {
            size_t offset;
            size_t length;
        };
        std::vector<TexBv> texBvs;
        for (const auto& tex : textures) {
            size_t pad = (4 - (currentOffset % 4)) % 4;
            currentOffset += pad;
            texBvs.push_back({currentOffset, tex.data.size()});
            currentOffset += tex.data.size();
        }

        size_t binPadding = (4 - (currentOffset % 4)) % 4;
        size_t binChunkLength = currentOffset + binPadding;

        std::vector<uint8_t> binData(binChunkLength, 0);

        for (size_t m = 0; m < numMeshes; ++m) {
            const auto& mesh = subMeshes[m];
            const auto& mo = meshOffsets[m];

            if (mo.indexCount > 0) {
                std::memcpy(binData.data() + mo.indexOffset, mesh.indices.data(), mo.indexBytes);
            }
            if (mo.vertCount > 0) {
                std::vector<float> posBuffer;
                posBuffer.reserve(mo.vertCount * 3);
                for (const auto& v : mesh.vertices) {
                    posBuffer.push_back(v.position.x);
                    posBuffer.push_back(v.position.y);
                    posBuffer.push_back(v.position.z);
                }
                std::memcpy(binData.data() + mo.posOffset, posBuffer.data(), mo.posBytes);

                std::vector<float> normBuffer;
                normBuffer.reserve(mo.vertCount * 3);
                for (const auto& v : mesh.vertices) {
                    normBuffer.push_back(v.normal.x);
                    normBuffer.push_back(v.normal.y);
                    normBuffer.push_back(v.normal.z);
                }
                std::memcpy(binData.data() + mo.normOffset, normBuffer.data(), mo.normBytes);

                std::vector<float> uvBuffer;
                uvBuffer.reserve(mo.vertCount * 2);
                for (const auto& v : mesh.vertices) {
                    uvBuffer.push_back(v.uv.x);
                    uvBuffer.push_back(v.uv.y);
                }
                std::memcpy(binData.data() + mo.uvOffset, uvBuffer.data(), mo.uvBytes);

                std::vector<float> colBuffer;
                colBuffer.reserve(mo.vertCount * 4);
                for (const auto& v : mesh.vertices) {
                    colBuffer.push_back(v.color.x);
                    colBuffer.push_back(v.color.y);
                    colBuffer.push_back(v.color.z);
                    colBuffer.push_back(v.color.w);
                }
                std::memcpy(binData.data() + mo.colorOffset, colBuffer.data(), mo.colorBytes);

                std::vector<float> tanBuffer;
                tanBuffer.reserve(mo.vertCount * 4);
                for (const auto& v : mesh.vertices) {
                    tanBuffer.push_back(v.tangent.x);
                    tanBuffer.push_back(v.tangent.y);
                    tanBuffer.push_back(v.tangent.z);
                    tanBuffer.push_back(v.tangent.w);
                }
                std::memcpy(binData.data() + mo.tangentOffset, tanBuffer.data(), mo.tangentBytes);
            }
        }

        for (size_t i = 0; i < textures.size(); ++i) {
            if (!textures[i].data.empty()) {
                std::memcpy(binData.data() + texBvs[i].offset, textures[i].data.data(), texBvs[i].length);
            }
        }

        // 2. Discover PBR extensions across materials & textures
        std::vector<std::string> extensionsUsed;
        bool hasTextureTransform = false;
        bool hasEmissiveStrength = false;

        for (const auto& t : textures) {
            if (std::abs(t.scaleU - 1.0f) > 1e-4f || std::abs(t.scaleV - 1.0f) > 1e-4f ||
                std::abs(t.offsetU) > 1e-4f || std::abs(t.offsetV) > 1e-4f) {
                hasTextureTransform = true;
            }
        }
        if (hasTextureTransform) extensionsUsed.push_back("KHR_texture_transform");

        bool hasClearcoat = false, hasTransmission = false, hasIor = false, hasVolume = false;
        for (const auto& mesh : subMeshes) {
            if (mesh.material.emissiveStrength > 1.001f) hasEmissiveStrength = true;
            if (mesh.material.clearcoatFactor > 0.0f) hasClearcoat = true;
            if (mesh.material.transmissionFactor > 0.0f) hasTransmission = true;
            if (std::abs(mesh.material.ior - 1.5f) > 0.001f || mesh.material.transmissionFactor > 0.0f) hasIor = true;
            if (mesh.material.thicknessFactor > 0.0f) hasVolume = true;
        }
        if (hasEmissiveStrength) extensionsUsed.push_back("KHR_materials_emissive_strength");
        if (hasClearcoat) extensionsUsed.push_back("KHR_materials_clearcoat");
        if (hasTransmission) extensionsUsed.push_back("KHR_materials_transmission");
        if (hasIor) extensionsUsed.push_back("KHR_materials_ior");
        if (hasVolume) extensionsUsed.push_back("KHR_materials_volume");

        if (!lights.empty()) extensionsUsed.push_back("KHR_lights_punctual");

        auto appendTexInfo = [&](int texIdx) {
            std::stringstream ts;
            ts << "{\"index\":" << texIdx;
            const auto& t = textures[texIdx];
            if (std::abs(t.scaleU - 1.0f) > 1e-4f || std::abs(t.scaleV - 1.0f) > 1e-4f ||
                std::abs(t.offsetU) > 1e-4f || std::abs(t.offsetV) > 1e-4f) {
                ts << ",\"extensions\":{\"KHR_texture_transform\":{\"scale\":[" << t.scaleU << "," << t.scaleV
                   << "],\"offset\":[" << t.offsetU << "," << t.offsetV << "]}}";
            }
            ts << "}";
            return ts.str();
        };

        // 3. Build JSON chunk
        std::stringstream ss;
        ss << "{"
           << "\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox Astro C++ MultiMesh Engine\"},";
        if (!extensionsUsed.empty()) {
            ss << "\"extensionsUsed\":[";
            for (size_t i = 0; i < extensionsUsed.size(); ++i) {
                ss << "\"" << extensionsUsed[i] << "\"";
                if (i + 1 < extensionsUsed.size()) ss << ",";
            }
            ss << "],";
        }

        // Scenes & Nodes
        ss << "\"scene\":0,"
           << "\"scenes\":[{\"nodes\":[";
        for (size_t m = 0; m < numMeshes; ++m) {
            if (m > 0) ss << ",";
            ss << m;
        }
        for (size_t i = 0; i < lights.size(); ++i) {
            ss << "," << (numMeshes + i);
        }
        ss << "]}],"
           << "\"nodes\":[";
        for (size_t m = 0; m < numMeshes; ++m) {
            if (m > 0) ss << ",";
            ss << "{\"mesh\":" << m << ",\"name\":\"" << subMeshes[m].name << "\"}";
        }
        for (size_t i = 0; i < lights.size(); ++i) {
            const auto& l = lights[i];
            auto q = directionToGltfQuat(l.direction);
            ss << ",{\"name\":\"" << l.name << "\",\"translation\":["
               << l.position.x << "," << l.position.y << "," << l.position.z << "]";
            if (l.type == lighting::LightType::DIRECTIONAL || l.type == lighting::LightType::SPOT) {
                ss << ",\"rotation\":[" << q[0] << "," << q[1] << "," << q[2] << "," << q[3] << "]";
            }
            ss << ",\"extensions\":{\"KHR_lights_punctual\":{\"light\":" << i << "}}}";
        }
        ss << "],";

        // Meshes
        // Materials: serialize per mesh, then share identical definitions instead of emitting one copy per mesh.
        std::vector<std::string> uniqueMaterialJson;
        std::vector<size_t> meshMaterialIndex(numMeshes, 0);
        for (size_t m = 0; m < numMeshes; ++m) {
            std::stringstream ms;
            const auto& mat = subMeshes[m].material;

            int baseColorTexIdx = -1;
            int mrTexIdx = -1;
            int normalTexIdx = -1;
            int occTexIdx = -1;
            int emissiveTexIdx = -1;

            for (size_t i = 0; i < textures.size(); ++i) {
                bool matchesMaterial = (textures[i].materialIndex == static_cast<int>(m));
                if (!textures[i].targetMaterialName.empty()) {
                    auto toLower = [](std::string s) {
                        for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                        return s;
                    };
                    std::string matLow = toLower(mat.name);
                    std::string subLow = toLower(subMeshes[m].name);
                    std::string targetLow = toLower(textures[i].targetMaterialName);

                    bool matchesTarget = (matLow.find(targetLow) != std::string::npos || subLow.find(targetLow) != std::string::npos);
                    if (targetLow == "bark" || targetLow == "wood") {
                        matchesTarget = matchesTarget || (matLow.find("bark") != std::string::npos || matLow.find("wood") != std::string::npos ||
                                                         subLow.find("bark") != std::string::npos || subLow.find("wood") != std::string::npos);
                    } else if (targetLow == "foliage" || targetLow == "leaf") {
                        matchesTarget = matchesTarget || (matLow.find("foliage") != std::string::npos || matLow.find("leaf") != std::string::npos ||
                                                         subLow.find("foliage") != std::string::npos || subLow.find("leaf") != std::string::npos);
                    }
                    matchesMaterial = matchesTarget;
                }

                if (matchesMaterial) {
                    if (textures[i].usage == TextureUsage::BASE_COLOR && baseColorTexIdx == -1) baseColorTexIdx = static_cast<int>(i);
                    else if ((textures[i].usage == TextureUsage::METALLIC_ROUGHNESS || textures[i].usage == TextureUsage::ORM) && mrTexIdx == -1) mrTexIdx = static_cast<int>(i);
                    else if (textures[i].usage == TextureUsage::NORMAL && normalTexIdx == -1) normalTexIdx = static_cast<int>(i);
                    else if (textures[i].usage == TextureUsage::OCCLUSION && occTexIdx == -1) occTexIdx = static_cast<int>(i);
                    else if (textures[i].usage == TextureUsage::EMISSIVE && emissiveTexIdx == -1) emissiveTexIdx = static_cast<int>(i);

                    if (textures[i].usage == TextureUsage::ORM && occTexIdx == -1) occTexIdx = static_cast<int>(i);
                }
            }

            ms << "{\"name\":\"" << mat.name << "\","
               << "\"pbrMetallicRoughness\":{"
               << "\"baseColorFactor\":[" << mat.baseColorFactor.x << "," << mat.baseColorFactor.y << "," << mat.baseColorFactor.z << "," << mat.baseColorFactor.w << "],"
               << "\"metallicFactor\":" << mat.metallicFactor << ","
               << "\"roughnessFactor\":" << mat.roughnessFactor;
            if (baseColorTexIdx >= 0) {
                ms << ",\"baseColorTexture\":" << appendTexInfo(baseColorTexIdx);
            }
            if (mrTexIdx >= 0) {
                ms << ",\"metallicRoughnessTexture\":" << appendTexInfo(mrTexIdx);
            }
            ms << "},"
               << "\"emissiveFactor\":[" << mat.emissiveFactor.x << "," << mat.emissiveFactor.y << "," << mat.emissiveFactor.z << "],";
            if (normalTexIdx >= 0) {
                ms << "\"normalTexture\":" << appendTexInfo(normalTexIdx) << ",";
            }
            if (occTexIdx >= 0) {
                ms << "\"occlusionTexture\":" << appendTexInfo(occTexIdx) << ",";
            }
            if (emissiveTexIdx >= 0) {
                ms << "\"emissiveTexture\":" << appendTexInfo(emissiveTexIdx) << ",";
            }
            ms << "\"doubleSided\":" << (mat.doubleSided ? "true" : "false");
            if (mat.alphaMode != "OPAQUE") {
                ms << ",\"alphaMode\":\"" << mat.alphaMode << "\"";
                if (mat.alphaMode == "MASK") {
                    ms << ",\"alphaCutoff\":" << mat.alphaCutoff;
                }
            }
            // Factor-only PBR extensions, written exactly when the extension discovery above lists them.
            std::vector<std::string> matExt;
            if (mat.emissiveStrength > 1.001f) {
                std::stringstream e; e << "\"KHR_materials_emissive_strength\":{\"emissiveStrength\":" << mat.emissiveStrength << "}";
                matExt.push_back(e.str());
            }
            if (mat.clearcoatFactor > 0.0f) {
                std::stringstream e; e << "\"KHR_materials_clearcoat\":{\"clearcoatFactor\":" << mat.clearcoatFactor
                                       << ",\"clearcoatRoughnessFactor\":" << mat.clearcoatRoughnessFactor << "}";
                matExt.push_back(e.str());
            }
            if (mat.transmissionFactor > 0.0f) {
                std::stringstream e; e << "\"KHR_materials_transmission\":{\"transmissionFactor\":" << mat.transmissionFactor << "}";
                matExt.push_back(e.str());
            }
            if (std::abs(mat.ior - 1.5f) > 0.001f || mat.transmissionFactor > 0.0f) {
                std::stringstream e; e << "\"KHR_materials_ior\":{\"ior\":" << mat.ior << "}";
                matExt.push_back(e.str());
            }
            if (mat.thicknessFactor > 0.0f) {
                std::stringstream e; e << "\"KHR_materials_volume\":{\"thicknessFactor\":" << mat.thicknessFactor
                                       << ",\"attenuationDistance\":" << mat.attenuationDistance
                                       << ",\"attenuationColor\":[" << mat.attenuationColor.x << "," << mat.attenuationColor.y << "," << mat.attenuationColor.z << "]}";
                matExt.push_back(e.str());
            }
            if (!matExt.empty()) {
                ms << ",\"extensions\":{";
                for (size_t i = 0; i < matExt.size(); ++i) ms << (i ? "," : "") << matExt[i];
                ms << "}";
            }
            if (!mat.extrasJson.empty()) ms << ",\"extras\":" << mat.extrasJson;
            ms << "}";
            const std::string json = ms.str();
            auto found = std::find(uniqueMaterialJson.begin(), uniqueMaterialJson.end(), json);
            meshMaterialIndex[m] = static_cast<size_t>(found - uniqueMaterialJson.begin());
            if (found == uniqueMaterialJson.end()) uniqueMaterialJson.push_back(json);
        }

        ss << "\"meshes\":[";
        for (size_t m = 0; m < numMeshes; ++m) {
            if (m > 0) ss << ",";
            size_t accBase = m * 6;
            ss << "{\"name\":\"" << subMeshes[m].name << "\",\"primitives\":[{"
               << "\"attributes\":{"
               << "\"POSITION\":" << (accBase + 1) << ","
               << "\"NORMAL\":" << (accBase + 2) << ","
               << "\"TEXCOORD_0\":" << (accBase + 3) << ","
               << "\"COLOR_0\":" << (accBase + 4) << ","
               << "\"TANGENT\":" << (accBase + 5)
               << "},"
               << "\"indices\":" << (accBase + 0) << ","
               << "\"material\":" << meshMaterialIndex[m]
               << "}]}";
        }
        ss << "],";

        ss << "\"materials\":[";
        for (size_t i = 0; i < uniqueMaterialJson.size(); ++i) {
            if (i > 0) ss << ",";
            ss << uniqueMaterialJson[i];
        }
        ss << "],";

        // Accessors
        ss << "\"accessors\":[";
        for (size_t m = 0; m < numMeshes; ++m) {
            if (m > 0) ss << ",";
            const auto& mo = meshOffsets[m];
            size_t bvBase = m * 6;
            ss << "{\"bufferView\":" << (bvBase + 0) << ",\"byteOffset\":0,\"componentType\":5125,\"count\":" << mo.indexCount << ",\"type\":\"SCALAR\"},"
               << "{\"bufferView\":" << (bvBase + 1) << ",\"byteOffset\":0,\"componentType\":5126,\"count\":" << mo.vertCount << ",\"type\":\"VEC3\",\"min\":[" << mo.minX << "," << mo.minY << "," << mo.minZ << "],\"max\":[" << mo.maxX << "," << mo.maxY << "," << mo.maxZ << "]},"
               << "{\"bufferView\":" << (bvBase + 2) << ",\"byteOffset\":0,\"componentType\":5126,\"count\":" << mo.vertCount << ",\"type\":\"VEC3\"},"
               << "{\"bufferView\":" << (bvBase + 3) << ",\"byteOffset\":0,\"componentType\":5126,\"count\":" << mo.vertCount << ",\"type\":\"VEC2\"},"
               << "{\"bufferView\":" << (bvBase + 4) << ",\"byteOffset\":0,\"componentType\":5126,\"count\":" << mo.vertCount << ",\"type\":\"VEC4\"},"
               << "{\"bufferView\":" << (bvBase + 5) << ",\"byteOffset\":0,\"componentType\":5126,\"count\":" << mo.vertCount << ",\"type\":\"VEC4\"}";
        }
        ss << "],";

        // BufferViews
        ss << "\"bufferViews\":[";
        for (size_t m = 0; m < numMeshes; ++m) {
            if (m > 0) ss << ",";
            const auto& mo = meshOffsets[m];
            ss << "{\"buffer\":0,\"byteOffset\":" << mo.indexOffset << ",\"byteLength\":" << mo.indexBytes << ",\"target\":34963},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.posOffset << ",\"byteLength\":" << mo.posBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.normOffset << ",\"byteLength\":" << mo.normBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.uvOffset << ",\"byteLength\":" << mo.uvBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.colorOffset << ",\"byteLength\":" << mo.colorBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.tangentOffset << ",\"byteLength\":" << mo.tangentBytes << ",\"target\":34962}";
        }
        for (size_t i = 0; i < textures.size(); ++i) {
            ss << ",{\"buffer\":0,\"byteOffset\":" << texBvs[i].offset << ",\"byteLength\":" << texBvs[i].length << "}";
        }
        ss << "]";

        // Samplers, Images & Textures
        if (!textures.empty()) {
            ss << ",\"samplers\":[{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":10497,\"wrapT\":10497}]";
            ss << ",\"images\":[";
            for (size_t i = 0; i < textures.size(); ++i) {
                if (i > 0) ss << ",";
                ss << "{\"bufferView\":" << (numMeshes * 6 + i) << ",\"mimeType\":\"" << textures[i].mimeType << "\"}";
            }
            ss << "]";
            ss << ",\"textures\":[";
            for (size_t i = 0; i < textures.size(); ++i) {
                if (i > 0) ss << ",";
                ss << "{\"sampler\":0,\"source\":" << i << "}";
            }
            ss << "]";
        }

        // Punctual lights extension if present
        if (!lights.empty()) {
            ss << ",\"extensions\":{\"KHR_lights_punctual\":{\"lights\":[";
            for (size_t i = 0; i < lights.size(); ++i) {
                if (i > 0) ss << ",";
                const auto& l = lights[i];
                std::string typeStr = (l.type == lighting::LightType::DIRECTIONAL) ? "directional" :
                                      ((l.type == lighting::LightType::SPOT) ? "spot" : "point");
                ss << "{\"name\":\"" << l.name << "\",\"type\":\"" << typeStr << "\","
                   << "\"color\":[" << l.color.x << "," << l.color.y << "," << l.color.z << "],"
                   << "\"intensity\":" << l.intensity;
                if (l.type != lighting::LightType::DIRECTIONAL && l.range > 0.0f) {
                    ss << ",\"range\":" << l.range;
                }
                if (l.type == lighting::LightType::SPOT) {
                    ss << ",\"spot\":{\"innerConeAngle\":" << l.innerConeAngle
                       << ",\"outerConeAngle\":" << l.outerConeAngle << "}";
                }
                ss << "}";
            }
            ss << "]}}";
        }

        ss << ",\"buffers\":[{\"byteLength\":" << binChunkLength << "}]}";

        std::string jsonStr = ss.str();
        size_t jsonPadding = (4 - (jsonStr.size() % 4)) % 4;
        for (size_t i = 0; i < jsonPadding; ++i) {
            jsonStr.push_back(' ');
        }
        uint32_t jsonChunkLength = static_cast<uint32_t>(jsonStr.size());

        // 4. Assemble standard GLB 2.0 container
        uint32_t totalLength = 12 + 8 + jsonChunkLength + 8 + static_cast<uint32_t>(binChunkLength);
        std::vector<uint8_t> glb(totalLength);
        uint8_t* out = glb.data();

        // Header (12 bytes)
        uint32_t magic = 0x46546C67; // 'glTF'
        uint32_t version = 2;
        std::memcpy(out + 0, &magic, 4);
        std::memcpy(out + 4, &version, 4);
        std::memcpy(out + 8, &totalLength, 4);
        out += 12;

        // JSON Chunk
        uint32_t jsonType = 0x4E4F534A; // 'JSON'
        std::memcpy(out + 0, &jsonChunkLength, 4);
        std::memcpy(out + 4, &jsonType, 4);
        out += 8;
        std::memcpy(out, jsonStr.data(), jsonChunkLength);
        out += jsonChunkLength;

        // BIN Chunk
        uint32_t binType = 0x004E4942; // 'BIN\0'
        uint32_t binLen = static_cast<uint32_t>(binChunkLength);
        std::memcpy(out + 0, &binLen, 4);
        std::memcpy(out + 4, &binType, 4);
        out += 8;
        std::memcpy(out, binData.data(), binChunkLength);

        return glb;
    }

    static bool writeMultiMeshToFile(
        const std::vector<ScratchboxMesh>& subMeshes,
        const std::string& filePath,
        const std::vector<EmbeddedTexture>& textures = {},
        const std::vector<lighting::Light>& lights = {}
    ) {
        auto glb = serializeMultiMeshToGlb(subMeshes, textures, lights);
        if (glb.empty()) return false;

        std::ofstream file(filePath, std::ios::binary);
        if (!file.is_open()) return false;

        file.write(reinterpret_cast<const char*>(glb.data()), glb.size());
        return true;
    }

    static bool writeToFile(const ScratchboxMesh& mesh, const std::string& filePath, const std::vector<EmbeddedTexture>& textures = {}, const std::vector<lighting::Light>& lights = {}) {
        auto glb = serializeToGlb(mesh, textures, lights);
        if (glb.empty()) return false;

        std::ofstream file(filePath, std::ios::binary);
        if (!file.is_open()) return false;

        file.write(reinterpret_cast<const char*>(glb.data()), glb.size());
        return true;
    }

    static void streamChunk(const ScratchboxMesh& mesh, const std::string& chunkId = "chunk-0", const std::vector<EmbeddedTexture>& textures = {}, const std::vector<lighting::Light>& lights = {}) {
        auto glb = serializeToGlb(mesh, textures, lights);
        if (glb.empty()) return;

        std::string name = chunkId.empty() ? mesh.name : chunkId;
        std::string b64 = base64Encode(glb.data(), glb.size());
        std::cout << "\n===SCRATCHBOX_3D_CHUNK_START===\n";
        std::cout << "{\"id\":\"" << chunkId << "\",\"name\":\"" << name
                  << "\",\"vertexCount\":" << mesh.vertices.size()
                  << ",\"indexCount\":" << mesh.indices.size()
                  << ",\"glbBase64\":\"" << b64 << "\"}\n";
        std::cout << "===SCRATCHBOX_3D_CHUNK_END===\n" << std::flush;
    }

    static void streamChunk(const Mesh& mesh, const std::string& chunkId = "chunk-0", const std::vector<EmbeddedTexture>& textures = {}) {
        streamChunk(mesh.toScratchboxMesh(), chunkId, textures);
    }

    static void streamChunk(const std::string& chunkId, const std::vector<uint8_t>& glb) {
        if (glb.empty()) return;
        std::string b64 = base64Encode(glb.data(), glb.size());
        std::cout << "\n===SCRATCHBOX_3D_CHUNK_START===\n";
        std::cout << "{\"id\":\"" << chunkId << "\",\"name\":\"" << chunkId
                  << "\",\"vertexCount\":0,\"indexCount\":0"
                  << ",\"glbBase64\":\"" << b64 << "\"}\n";
        std::cout << "===SCRATCHBOX_3D_CHUNK_END===\n" << std::flush;
    }

    /**
     * Serializes a fully rigged, skinned mesh with joint hierarchy and inverse bind matrices to glTF 2.0 (.glb)
     */
    static std::vector<uint8_t> serializeSkinnedGlb(
        const ScratchboxMesh& mesh,
        const std::vector<skinning::VertexSkinWeight>& skinWeights,
        const kinematics::Skeleton& skeleton
    ) {
        if (mesh.vertices.empty()) return {};

        // 1. Pack binary buffer (BIN chunk)
        size_t indexBytes = mesh.indices.size() * sizeof(uint32_t);
        size_t posBytes = mesh.vertices.size() * 3 * sizeof(float);
        size_t normBytes = mesh.vertices.size() * 3 * sizeof(float);
        size_t uvBytes = mesh.vertices.size() * 2 * sizeof(float);
        size_t colorBytes = mesh.vertices.size() * 4 * sizeof(float);
        size_t tangentBytes = mesh.vertices.size() * 4 * sizeof(float);
        size_t jointsBytes = mesh.vertices.size() * 4 * sizeof(uint16_t);
        size_t weightsBytes = mesh.vertices.size() * 4 * sizeof(float);
        size_t invBindBytes = skeleton.joints.size() * 16 * sizeof(float);

        size_t totalBinBytes = indexBytes + posBytes + normBytes + uvBytes + colorBytes +
                               tangentBytes + jointsBytes + weightsBytes + invBindBytes;
        size_t binPadding = (4 - (totalBinBytes % 4)) % 4;
        size_t binChunkLength = totalBinBytes + binPadding;

        std::vector<uint8_t> binData(binChunkLength, 0);
        uint8_t* ptr = binData.data();

        // Indices
        size_t indexOffset = 0;
        std::memcpy(ptr, mesh.indices.data(), indexBytes);
        ptr += indexBytes;

        // Positions
        size_t posOffset = indexOffset + indexBytes;
        float minX = 1e9f, minY = 1e9f, minZ = 1e9f;
        float maxX = -1e9f, maxY = -1e9f, maxZ = -1e9f;
        std::vector<float> posBuffer;
        posBuffer.reserve(mesh.vertices.size() * 3);
        for (const auto& v : mesh.vertices) {
            posBuffer.push_back(v.position.x);
            posBuffer.push_back(v.position.y);
            posBuffer.push_back(v.position.z);
            minX = std::min(minX, v.position.x);
            minY = std::min(minY, v.position.y);
            minZ = std::min(minZ, v.position.z);
            maxX = std::max(maxX, v.position.x);
            maxY = std::max(maxY, v.position.y);
            maxZ = std::max(maxZ, v.position.z);
        }
        std::memcpy(ptr, posBuffer.data(), posBytes);
        ptr += posBytes;

        // Normals
        size_t normOffset = posOffset + posBytes;
        std::vector<float> normBuffer;
        normBuffer.reserve(mesh.vertices.size() * 3);
        for (const auto& v : mesh.vertices) {
            normBuffer.push_back(v.normal.x);
            normBuffer.push_back(v.normal.y);
            normBuffer.push_back(v.normal.z);
        }
        std::memcpy(ptr, normBuffer.data(), normBytes);
        ptr += normBytes;

        // UVs
        size_t uvOffset = normOffset + normBytes;
        std::vector<float> uvBuffer;
        uvBuffer.reserve(mesh.vertices.size() * 2);
        for (const auto& v : mesh.vertices) {
            uvBuffer.push_back(v.uv.x);
            uvBuffer.push_back(v.uv.y);
        }
        std::memcpy(ptr, uvBuffer.data(), uvBytes);
        ptr += uvBytes;

        // Colors
        size_t colorOffset = uvOffset + uvBytes;
        std::vector<float> colorBuffer;
        colorBuffer.reserve(mesh.vertices.size() * 4);
        for (const auto& v : mesh.vertices) {
            colorBuffer.push_back(v.color.x);
            colorBuffer.push_back(v.color.y);
            colorBuffer.push_back(v.color.z);
            colorBuffer.push_back(v.color.w);
        }
        std::memcpy(ptr, colorBuffer.data(), colorBytes);
        ptr += colorBytes;

        // Tangents
        size_t tangentOffset = colorOffset + colorBytes;
        std::vector<float> tangentBuffer;
        tangentBuffer.reserve(mesh.vertices.size() * 4);
        for (const auto& v : mesh.vertices) {
            tangentBuffer.push_back(v.tangent.x);
            tangentBuffer.push_back(v.tangent.y);
            tangentBuffer.push_back(v.tangent.z);
            tangentBuffer.push_back(v.tangent.w);
        }
        std::memcpy(ptr, tangentBuffer.data(), tangentBytes);
        ptr += tangentBytes;

        // JOINTS_0
        size_t jointsOffset = tangentOffset + tangentBytes;
        std::vector<uint16_t> jointsBuffer;
        jointsBuffer.reserve(mesh.vertices.size() * 4);
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            if (i < skinWeights.size()) {
                jointsBuffer.push_back(skinWeights[i].joints[0]);
                jointsBuffer.push_back(skinWeights[i].joints[1]);
                jointsBuffer.push_back(skinWeights[i].joints[2]);
                jointsBuffer.push_back(skinWeights[i].joints[3]);
            } else {
                jointsBuffer.push_back(0);
                jointsBuffer.push_back(0);
                jointsBuffer.push_back(0);
                jointsBuffer.push_back(0);
            }
        }
        std::memcpy(ptr, jointsBuffer.data(), jointsBytes);
        ptr += jointsBytes;

        // WEIGHTS_0
        size_t weightsOffset = jointsOffset + jointsBytes;
        std::vector<float> weightsBuffer;
        weightsBuffer.reserve(mesh.vertices.size() * 4);
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            if (i < skinWeights.size()) {
                weightsBuffer.push_back(skinWeights[i].weights[0]);
                weightsBuffer.push_back(skinWeights[i].weights[1]);
                weightsBuffer.push_back(skinWeights[i].weights[2]);
                weightsBuffer.push_back(skinWeights[i].weights[3]);
            } else {
                weightsBuffer.push_back(1.0f);
                weightsBuffer.push_back(0.0f);
                weightsBuffer.push_back(0.0f);
                weightsBuffer.push_back(0.0f);
            }
        }
        std::memcpy(ptr, weightsBuffer.data(), weightsBytes);
        ptr += weightsBytes;

        // Inverse Bind Matrices
        size_t invBindOffset = weightsOffset + weightsBytes;
        std::vector<float> invBindBuffer;
        invBindBuffer.reserve(skeleton.joints.size() * 16);
        for (const auto& j : skeleton.joints) {
            math::Mat4 inv = math::Mat4::translation(-j.restPosition);
            for (int k = 0; k < 16; ++k) {
                invBindBuffer.push_back(inv.m[k]);
            }
        }
        std::memcpy(ptr, invBindBuffer.data(), invBindBytes);

        // 2. Build JSON chunk
        std::stringstream ss;
        ss << "{"
           << "\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox Astro C++ Engine\"},"
           << "\"scene\":0,"
           << "\"scenes\":[{\"nodes\":[0";

        for (size_t i = 0; i < skeleton.joints.size(); ++i) {
            if (skeleton.joints[i].parentIndex < 0) {
                ss << "," << (i + 1);
            }
        }
        ss << "]}],";

        // Nodes: node 0 is the skinned mesh node, nodes 1..K are bone nodes
        ss << "\"nodes\":[";
        ss << "{\"name\":\"" << mesh.name << "\",\"mesh\":0,\"skin\":0}";

        for (size_t i = 0; i < skeleton.joints.size(); ++i) {
            const auto& j = skeleton.joints[i];
            ss << ",{";
            ss << "\"name\":\"" << j.name << "\",";

            math::Vec3 localT = j.restPosition;
            if (j.parentIndex >= 0 && j.parentIndex < static_cast<int32_t>(skeleton.joints.size())) {
                localT = j.restPosition - skeleton.joints[j.parentIndex].restPosition;
            }
            ss << "\"translation\":[" << localT.x << "," << localT.y << "," << localT.z << "]";

            std::vector<int> children;
            for (size_t c = 0; c < skeleton.joints.size(); ++c) {
                if (skeleton.joints[c].parentIndex == static_cast<int32_t>(i)) {
                    children.push_back(static_cast<int>(c + 1));
                }
            }
            if (!children.empty()) {
                ss << ",\"children\":[";
                for (size_t c = 0; c < children.size(); ++c) {
                    ss << children[c];
                    if (c + 1 < children.size()) ss << ",";
                }
                ss << "]";
            }
            ss << "}";
        }
        ss << "],";

        // Skins
        ss << "\"skins\":[{";
        ss << "\"name\":\"" << mesh.name << "_skin\",";
        ss << "\"inverseBindMatrices\":8,";
        ss << "\"joints\":[";
        for (size_t i = 0; i < skeleton.joints.size(); ++i) {
            ss << (i + 1);
            if (i + 1 < skeleton.joints.size()) ss << ",";
        }
        ss << "]";
        if (!skeleton.joints.empty()) {
            ss << ",\"skeleton\":1";
        }
        ss << "}],";

        // Meshes
        ss << "\"meshes\":[{\"name\":\"" << mesh.name << "\",\"primitives\":[{"
           << "\"attributes\":{"
           << "\"POSITION\":1,\"NORMAL\":2,\"TEXCOORD_0\":3,\"COLOR_0\":4,\"TANGENT\":5,"
           << "\"JOINTS_0\":6,\"WEIGHTS_0\":7"
           << "},"
           << "\"indices\":0,"
           << "\"material\":0"
           << "}]}],"
           << "\"materials\":[{"
           << "\"name\":\"" << mesh.material.name << "\","
           << "\"pbrMetallicRoughness\":{"
           << "\"baseColorFactor\":[" << mesh.material.baseColorFactor.x << "," << mesh.material.baseColorFactor.y << "," << mesh.material.baseColorFactor.z << "," << mesh.material.baseColorFactor.w << "],"
           << "\"metallicFactor\":" << mesh.material.metallicFactor << ","
           << "\"roughnessFactor\":" << mesh.material.roughnessFactor
           << "},"
           << "\"emissiveFactor\":[" << mesh.material.emissiveFactor.x << "," << mesh.material.emissiveFactor.y << "," << mesh.material.emissiveFactor.z << "],"
           << "\"doubleSided\":" << (mesh.material.doubleSided ? "true" : "false")
           << "}],"
           << "\"accessors\":["
           << "{\"bufferView\":0,\"byteOffset\":0,\"componentType\":5125,\"count\":" << mesh.indices.size() << ",\"type\":\"SCALAR\"},"
           << "{\"bufferView\":1,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC3\",\"min\":[" << minX << "," << minY << "," << minZ << "],\"max\":[" << maxX << "," << maxY << "," << maxZ << "]},"
           << "{\"bufferView\":2,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC3\"},"
           << "{\"bufferView\":3,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC2\"},"
           << "{\"bufferView\":4,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":5,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":6,\"byteOffset\":0,\"componentType\":5123,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":7,\"byteOffset\":0,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":8,\"byteOffset\":0,\"componentType\":5126,\"count\":" << skeleton.joints.size() << ",\"type\":\"MAT4\"}"
           << "],"
           << "\"bufferViews\":["
           << "{\"buffer\":0,\"byteOffset\":" << indexOffset << ",\"byteLength\":" << indexBytes << ",\"target\":34963},"
           << "{\"buffer\":0,\"byteOffset\":" << posOffset << ",\"byteLength\":" << posBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << normOffset << ",\"byteLength\":" << normBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << uvOffset << ",\"byteLength\":" << uvBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << colorOffset << ",\"byteLength\":" << colorBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << tangentOffset << ",\"byteLength\":" << tangentBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << jointsOffset << ",\"byteLength\":" << jointsBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << weightsOffset << ",\"byteLength\":" << weightsBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << invBindOffset << ",\"byteLength\":" << invBindBytes << "}"
           << "],"
           << "\"buffers\":[{\"byteLength\":" << binChunkLength << "}]"
           << "}";

        std::string jsonStr = ss.str();
        size_t jsonPadding = (4 - (jsonStr.size() % 4)) % 4;
        jsonStr.append(jsonPadding, ' ');

        uint32_t jsonChunkLength = static_cast<uint32_t>(jsonStr.size());
        uint32_t totalLength = 12 + 8 + jsonChunkLength + 8 + static_cast<uint32_t>(binChunkLength);

        // 3. Assemble binary container
        std::vector<uint8_t> glb(totalLength);
        uint8_t* out = glb.data();

        // 12-byte header
        uint32_t magic = 0x46546C67; // "glTF"
        uint32_t version = 2;
        std::memcpy(out + 0, &magic, 4);
        std::memcpy(out + 4, &version, 4);
        std::memcpy(out + 8, &totalLength, 4);
        out += 12;

        // JSON Chunk header
        uint32_t jsonType = 0x4E4F534A; // "JSON"
        std::memcpy(out + 0, &jsonChunkLength, 4);
        std::memcpy(out + 4, &jsonType, 4);
        out += 8;
        std::memcpy(out, jsonStr.data(), jsonChunkLength);
        out += jsonChunkLength;

        // BIN Chunk header
        uint32_t binType = 0x004E4942; // "BIN\0"
        uint32_t binLen = static_cast<uint32_t>(binChunkLength);
        std::memcpy(out + 0, &binLen, 4);
        std::memcpy(out + 4, &binType, 4);
        out += 8;
        std::memcpy(out, binData.data(), binChunkLength);

        return glb;
    }

    static void streamSkinnedChunk(
        const ScratchboxMesh& mesh,
        const std::vector<skinning::VertexSkinWeight>& skinWeights,
        const kinematics::Skeleton& skeleton,
        const std::string& chunkId = "chunk-skinned-0"
    ) {
        auto glb = serializeSkinnedGlb(mesh, skinWeights, skeleton);
        if (glb.empty()) return;

        std::string name = chunkId.empty() ? mesh.name : chunkId;
        std::string b64 = base64Encode(glb.data(), glb.size());
        std::cout << "\n===SCRATCHBOX_3D_CHUNK_START===\n";
        std::cout << "{\"id\":\"" << chunkId << "\",\"name\":\"" << name
                  << "\",\"vertexCount\":" << mesh.vertices.size()
                  << ",\"indexCount\":" << mesh.indices.size()
                  << ",\"isSkinned\":true"
                  << ",\"jointCount\":" << skeleton.joints.size()
                  << ",\"glbBase64\":\"" << b64 << "\"}\n";
        std::cout << "===SCRATCHBOX_3D_CHUNK_END===\n" << std::flush;
    }

    /**
     * Serializes a mesh with GPU instance transforms via glTF EXT_mesh_gpu_instancing
     */
    static std::vector<uint8_t> serializeInstancedGlb(
        const ScratchboxMesh& mesh,
        const std::vector<InstanceTransform>& instances
    ) {
        if (mesh.vertices.empty() || instances.empty()) return {};

        // 1. Pack binary buffer (BIN chunk)
        size_t indexBytes = mesh.indices.size() * sizeof(uint32_t);
        size_t posBytes = mesh.vertices.size() * 3 * sizeof(float);
        size_t normBytes = mesh.vertices.size() * 3 * sizeof(float);
        size_t uvBytes = mesh.vertices.size() * 2 * sizeof(float);
        size_t colorBytes = mesh.vertices.size() * 4 * sizeof(float);
        size_t tangentBytes = mesh.vertices.size() * 4 * sizeof(float);

        size_t transBytes = instances.size() * 3 * sizeof(float);
        size_t rotBytes = instances.size() * 4 * sizeof(float);
        size_t scaleBytes = instances.size() * 3 * sizeof(float);

        size_t totalBinBytes = indexBytes + posBytes + normBytes + uvBytes + colorBytes +
                               tangentBytes + transBytes + rotBytes + scaleBytes;
        size_t binPadding = (4 - (totalBinBytes % 4)) % 4;
        size_t binChunkLength = totalBinBytes + binPadding;

        std::vector<uint8_t> binData(binChunkLength, 0);
        uint8_t* ptr = binData.data();

        // Indices
        size_t indexOffset = 0;
        std::memcpy(ptr, mesh.indices.data(), indexBytes);
        ptr += indexBytes;

        // Positions
        size_t posOffset = indexOffset + indexBytes;
        float minX = 1e9f, minY = 1e9f, minZ = 1e9f;
        float maxX = -1e9f, maxY = -1e9f, maxZ = -1e9f;
        std::vector<float> posBuffer;
        posBuffer.reserve(mesh.vertices.size() * 3);
        for (const auto& v : mesh.vertices) {
            posBuffer.push_back(v.position.x);
            posBuffer.push_back(v.position.y);
            posBuffer.push_back(v.position.z);
            minX = std::min(minX, v.position.x);
            minY = std::min(minY, v.position.y);
            minZ = std::min(minZ, v.position.z);
            maxX = std::max(maxX, v.position.x);
            maxY = std::max(maxY, v.position.y);
            maxZ = std::max(maxZ, v.position.z);
        }
        std::memcpy(ptr, posBuffer.data(), posBytes);
        ptr += posBytes;

        // Normals
        size_t normOffset = posOffset + posBytes;
        std::vector<float> normBuffer;
        normBuffer.reserve(mesh.vertices.size() * 3);
        for (const auto& v : mesh.vertices) {
            normBuffer.push_back(v.normal.x);
            normBuffer.push_back(v.normal.y);
            normBuffer.push_back(v.normal.z);
        }
        std::memcpy(ptr, normBuffer.data(), normBytes);
        ptr += normBytes;

        // UVs
        size_t uvOffset = normOffset + normBytes;
        std::vector<float> uvBuffer;
        uvBuffer.reserve(mesh.vertices.size() * 2);
        for (const auto& v : mesh.vertices) {
            uvBuffer.push_back(v.uv.x);
            uvBuffer.push_back(v.uv.y);
        }
        std::memcpy(ptr, uvBuffer.data(), uvBytes);
        ptr += uvBytes;

        // Colors
        size_t colorOffset = uvOffset + uvBytes;
        std::vector<float> colorBuffer;
        colorBuffer.reserve(mesh.vertices.size() * 4);
        for (const auto& v : mesh.vertices) {
            colorBuffer.push_back(v.color.x);
            colorBuffer.push_back(v.color.y);
            colorBuffer.push_back(v.color.z);
            colorBuffer.push_back(v.color.w);
        }
        std::memcpy(ptr, colorBuffer.data(), colorBytes);
        ptr += colorBytes;

        // Tangents
        size_t tangentOffset = colorOffset + colorBytes;
        std::vector<float> tangentBuffer;
        tangentBuffer.reserve(mesh.vertices.size() * 4);
        for (const auto& v : mesh.vertices) {
            tangentBuffer.push_back(v.tangent.x);
            tangentBuffer.push_back(v.tangent.y);
            tangentBuffer.push_back(v.tangent.z);
            tangentBuffer.push_back(v.tangent.w);
        }
        std::memcpy(ptr, tangentBuffer.data(), tangentBytes);
        ptr += tangentBytes;

        // Instance Translations
        size_t transOffset = tangentOffset + tangentBytes;
        float tMinX = 1e9f, tMinY = 1e9f, tMinZ = 1e9f;
        float tMaxX = -1e9f, tMaxY = -1e9f, tMaxZ = -1e9f;
        std::vector<float> transBuffer;
        transBuffer.reserve(instances.size() * 3);
        for (const auto& inst : instances) {
            transBuffer.push_back(inst.position.x);
            transBuffer.push_back(inst.position.y);
            transBuffer.push_back(inst.position.z);
            tMinX = std::min(tMinX, inst.position.x);
            tMinY = std::min(tMinY, inst.position.y);
            tMinZ = std::min(tMinZ, inst.position.z);
            tMaxX = std::max(tMaxX, inst.position.x);
            tMaxY = std::max(tMaxY, inst.position.y);
            tMaxZ = std::max(tMaxZ, inst.position.z);
        }
        std::memcpy(ptr, transBuffer.data(), transBytes);
        ptr += transBytes;

        // Instance Rotations
        size_t rotOffset = transOffset + transBytes;
        std::vector<float> rotBuffer;
        rotBuffer.reserve(instances.size() * 4);
        for (const auto& inst : instances) {
            rotBuffer.push_back(inst.rotation.x);
            rotBuffer.push_back(inst.rotation.y);
            rotBuffer.push_back(inst.rotation.z);
            rotBuffer.push_back(inst.rotation.w);
        }
        std::memcpy(ptr, rotBuffer.data(), rotBytes);
        ptr += rotBytes;

        // Instance Scales
        size_t scaleOffset = rotOffset + rotBytes;
        float sMinX = 1e9f, sMinY = 1e9f, sMinZ = 1e9f;
        float sMaxX = -1e9f, sMaxY = -1e9f, sMaxZ = -1e9f;
        std::vector<float> scaleBuffer;
        scaleBuffer.reserve(instances.size() * 3);
        for (const auto& inst : instances) {
            scaleBuffer.push_back(inst.scale.x);
            scaleBuffer.push_back(inst.scale.y);
            scaleBuffer.push_back(inst.scale.z);
            sMinX = std::min(sMinX, inst.scale.x);
            sMinY = std::min(sMinY, inst.scale.y);
            sMinZ = std::min(sMinZ, inst.scale.z);
            sMaxX = std::max(sMaxX, inst.scale.x);
            sMaxY = std::max(sMaxY, inst.scale.y);
            sMaxZ = std::max(sMaxZ, inst.scale.z);
        }
        std::memcpy(ptr, scaleBuffer.data(), scaleBytes);
        ptr += scaleBytes;

        // 2. Build JSON chunk
        std::stringstream ss;
        ss << "{"
           << "\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox Astro GPU Instancing\"},"
           << "\"extensionsUsed\":[\"EXT_mesh_gpu_instancing\"],"
           << "\"extensionsRequired\":[\"EXT_mesh_gpu_instancing\"],"
           << "\"scene\":0,"
           << "\"scenes\":[{\"nodes\":[0]}],"
           << "\"nodes\":[{"
           << "\"mesh\":0,"
           << "\"extensions\":{"
           << "\"EXT_mesh_gpu_instancing\":{"
           << "\"attributes\":{"
           << "\"TRANSLATION\":6,"
           << "\"ROTATION\":7,"
           << "\"SCALE\":8"
           << "}"
           << "}"
           << "}"
           << "],"
           << "\"meshes\":[{"
           << "\"primitives\":[{"
           << "\"attributes\":{"
           << "\"POSITION\":1,"
           << "\"NORMAL\":2,"
           << "\"TEXCOORD_0\":3,"
           << "\"COLOR_0\":4,"
           << "\"TANGENT\":5"
           << "},"
           << "\"indices\":0,"
           << "\"material\":0"
           << "}]"
           << "}],"
           << "\"materials\":[{"
           << "\"name\":\"" << mesh.material.name << "\","
           << "\"pbrMetallicRoughness\":{"
           << "\"baseColorFactor\":[" << mesh.material.baseColorFactor.x << "," << mesh.material.baseColorFactor.y << "," << mesh.material.baseColorFactor.z << "," << mesh.material.baseColorFactor.w << "],"
           << "\"metallicFactor\":" << mesh.material.metallicFactor << ","
           << "\"roughnessFactor\":" << mesh.material.roughnessFactor
           << "},"
           << "\"doubleSided\":true"
           << "}],"
           << "\"accessors\":["
           << "{\"bufferView\":0,\"componentType\":5125,\"count\":" << mesh.indices.size() << ",\"type\":\"SCALAR\"},"
           << "{\"bufferView\":1,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC3\",\"max\":[" << maxX << "," << maxY << "," << maxZ << "],\"min\":[" << minX << "," << minY << "," << minZ << "]},"
           << "{\"bufferView\":2,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC3\"},"
           << "{\"bufferView\":3,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC2\"},"
           << "{\"bufferView\":4,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":5,\"componentType\":5126,\"count\":" << mesh.vertices.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":6,\"componentType\":5126,\"count\":" << instances.size() << ",\"type\":\"VEC3\",\"max\":[" << tMaxX << "," << tMaxY << "," << tMaxZ << "],\"min\":[" << tMinX << "," << tMinY << "," << tMinZ << "]},"
           << "{\"bufferView\":7,\"componentType\":5126,\"count\":" << instances.size() << ",\"type\":\"VEC4\"},"
           << "{\"bufferView\":8,\"componentType\":5126,\"count\":" << instances.size() << ",\"type\":\"VEC3\",\"max\":[" << sMaxX << "," << sMaxY << "," << sMaxZ << "],\"min\":[" << sMinX << "," << sMinY << "," << sMinZ << "]}"
           << "],"
           << "\"bufferViews\":["
           << "{\"buffer\":0,\"byteOffset\":" << indexOffset << ",\"byteLength\":" << indexBytes << ",\"target\":34963},"
           << "{\"buffer\":0,\"byteOffset\":" << posOffset << ",\"byteLength\":" << posBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << normOffset << ",\"byteLength\":" << normBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << uvOffset << ",\"byteLength\":" << uvBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << colorOffset << ",\"byteLength\":" << colorBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << tangentOffset << ",\"byteLength\":" << tangentBytes << ",\"target\":34962},"
           << "{\"buffer\":0,\"byteOffset\":" << transOffset << ",\"byteLength\":" << transBytes << "},"
           << "{\"buffer\":0,\"byteOffset\":" << rotOffset << ",\"byteLength\":" << rotBytes << "},"
           << "{\"buffer\":0,\"byteOffset\":" << scaleOffset << ",\"byteLength\":" << scaleBytes << "}"
           << "],"
           << "\"buffers\":[{\"byteLength\":" << binChunkLength << "}]"
           << "}";

        std::string jsonStr = ss.str();
        size_t jsonPadding = (4 - (jsonStr.size() % 4)) % 4;
        jsonStr.append(jsonPadding, ' ');

        uint32_t jsonChunkLength = static_cast<uint32_t>(jsonStr.size());
        uint32_t totalLength = 12 + 8 + jsonChunkLength + 8 + static_cast<uint32_t>(binChunkLength);

        std::vector<uint8_t> glb(totalLength);
        uint8_t* out = glb.data();

        // 12-byte header
        uint32_t magic = 0x46546C67; // "glTF"
        uint32_t version = 2;
        std::memcpy(out + 0, &magic, 4);
        std::memcpy(out + 4, &version, 4);
        std::memcpy(out + 8, &totalLength, 4);
        out += 12;

        // JSON Chunk header
        uint32_t jsonType = 0x4E4F534A; // "JSON"
        std::memcpy(out + 0, &jsonChunkLength, 4);
        std::memcpy(out + 4, &jsonType, 4);
        out += 8;
        std::memcpy(out, jsonStr.data(), jsonChunkLength);
        out += jsonChunkLength;

        // BIN Chunk header
        uint32_t binType = 0x004E4942; // "BIN\0"
        uint32_t binLen = static_cast<uint32_t>(binChunkLength);
        std::memcpy(out + 0, &binLen, 4);
        std::memcpy(out + 4, &binType, 4);
        out += 8;
        std::memcpy(out, binData.data(), binChunkLength);

        return glb;
    }

    static void streamInstancedChunk(
        const ScratchboxMesh& mesh,
        const std::vector<InstanceTransform>& instances,
        const std::string& chunkId = "chunk-instanced-0"
    ) {
        auto glb = serializeInstancedGlb(mesh, instances);
        if (glb.empty()) return;

        std::string name = chunkId.empty() ? mesh.name : chunkId;
        std::string b64 = base64Encode(glb.data(), glb.size());
        std::cout << "\n===SCRATCHBOX_3D_CHUNK_START===\n";
        std::cout << "{\"id\":\"" << chunkId << "\",\"name\":\"" << name
                  << "\",\"vertexCount\":" << mesh.vertices.size()
                  << ",\"indexCount\":" << mesh.indices.size()
                  << ",\"isInstanced\":true"
                  << ",\"instanceCount\":" << instances.size()
                  << ",\"glbBase64\":\"" << b64 << "\"}\n";
        std::cout << "===SCRATCHBOX_3D_CHUNK_END===\n" << std::flush;
    }

    /**
     * Serializes a multi-resolution LOD hierarchy into glTF 2.0 with MSFT_lod extension
     */
    static std::vector<uint8_t> serializeLodGlb(
        const std::vector<ScratchboxMesh>& lodMeshes
    ) {
        if (lodMeshes.empty()) return {};

        size_t M = lodMeshes.size();

        size_t totalBinBytes = 0;
        for (const auto& mesh : lodMeshes) {
            totalBinBytes += mesh.indices.size() * sizeof(uint32_t);
            totalBinBytes += mesh.vertices.size() * 3 * sizeof(float);
            totalBinBytes += mesh.vertices.size() * 3 * sizeof(float);
            totalBinBytes += mesh.vertices.size() * 2 * sizeof(float);
            totalBinBytes += mesh.vertices.size() * 4 * sizeof(float);
            totalBinBytes += mesh.vertices.size() * 4 * sizeof(float);
        }

        size_t binPadding = (4 - (totalBinBytes % 4)) % 4;
        size_t binChunkLength = totalBinBytes + binPadding;

        std::vector<uint8_t> binData(binChunkLength, 0);
        uint8_t* ptr = binData.data();

        struct MeshOffsets {
            size_t idxOffset{0}, idxBytes{0}, idxCount{0};
            size_t posOffset{0}, posBytes{0}, posCount{0};
            float minX{1e9f}, minY{1e9f}, minZ{1e9f}, maxX{-1e9f}, maxY{-1e9f}, maxZ{-1e9f};
            size_t normOffset{0}, normBytes{0};
            size_t uvOffset{0}, uvBytes{0};
            size_t colOffset{0}, colBytes{0};
            size_t tanOffset{0}, tanBytes{0};
        };

        std::vector<MeshOffsets> meshOffsets(M);
        size_t currentByteOffset = 0;

        for (size_t m = 0; m < M; ++m) {
            const auto& mesh = lodMeshes[m];
            auto& mo = meshOffsets[m];

            mo.idxOffset = currentByteOffset;
            mo.idxBytes = mesh.indices.size() * sizeof(uint32_t);
            mo.idxCount = mesh.indices.size();
            std::memcpy(ptr, mesh.indices.data(), mo.idxBytes);
            ptr += mo.idxBytes;
            currentByteOffset += mo.idxBytes;

            mo.posOffset = currentByteOffset;
            mo.posBytes = mesh.vertices.size() * 3 * sizeof(float);
            mo.posCount = mesh.vertices.size();
            std::vector<float> posBuffer;
            posBuffer.reserve(mesh.vertices.size() * 3);
            for (const auto& v : mesh.vertices) {
                posBuffer.push_back(v.position.x);
                posBuffer.push_back(v.position.y);
                posBuffer.push_back(v.position.z);
                mo.minX = std::min(mo.minX, v.position.x);
                mo.minY = std::min(mo.minY, v.position.y);
                mo.minZ = std::min(mo.minZ, v.position.z);
                mo.maxX = std::max(mo.maxX, v.position.x);
                mo.maxY = std::max(mo.maxY, v.position.y);
                mo.maxZ = std::max(mo.maxZ, v.position.z);
            }
            std::memcpy(ptr, posBuffer.data(), mo.posBytes);
            ptr += mo.posBytes;
            currentByteOffset += mo.posBytes;

            mo.normOffset = currentByteOffset;
            mo.normBytes = mesh.vertices.size() * 3 * sizeof(float);
            std::vector<float> normBuffer;
            normBuffer.reserve(mesh.vertices.size() * 3);
            for (const auto& v : mesh.vertices) {
                normBuffer.push_back(v.normal.x);
                normBuffer.push_back(v.normal.y);
                normBuffer.push_back(v.normal.z);
            }
            std::memcpy(ptr, normBuffer.data(), mo.normBytes);
            ptr += mo.normBytes;
            currentByteOffset += mo.normBytes;

            mo.uvOffset = currentByteOffset;
            mo.uvBytes = mesh.vertices.size() * 2 * sizeof(float);
            std::vector<float> uvBuffer;
            uvBuffer.reserve(mesh.vertices.size() * 2);
            for (const auto& v : mesh.vertices) {
                uvBuffer.push_back(v.uv.x);
                uvBuffer.push_back(v.uv.y);
            }
            std::memcpy(ptr, uvBuffer.data(), mo.uvBytes);
            ptr += mo.uvBytes;
            currentByteOffset += mo.uvBytes;

            mo.colOffset = currentByteOffset;
            mo.colBytes = mesh.vertices.size() * 4 * sizeof(float);
            std::vector<float> colBuffer;
            colBuffer.reserve(mesh.vertices.size() * 4);
            for (const auto& v : mesh.vertices) {
                colBuffer.push_back(v.color.x);
                colBuffer.push_back(v.color.y);
                colBuffer.push_back(v.color.z);
                colBuffer.push_back(v.color.w);
            }
            std::memcpy(ptr, colBuffer.data(), mo.colBytes);
            ptr += mo.colBytes;
            currentByteOffset += mo.colBytes;

            mo.tanOffset = currentByteOffset;
            mo.tanBytes = mesh.vertices.size() * 4 * sizeof(float);
            std::vector<float> tanBuffer;
            tanBuffer.reserve(mesh.vertices.size() * 4);
            for (const auto& v : mesh.vertices) {
                tanBuffer.push_back(v.tangent.x);
                tanBuffer.push_back(v.tangent.y);
                tanBuffer.push_back(v.tangent.z);
                tanBuffer.push_back(v.tangent.w);
            }
            std::memcpy(ptr, tanBuffer.data(), mo.tanBytes);
            ptr += mo.tanBytes;
            currentByteOffset += mo.tanBytes;
        }

        std::stringstream ss;
        ss << "{"
           << "\"asset\":{\"version\":\"2.0\",\"generator\":\"Scratchbox Astro MSFT_lod\"},"
           << "\"extensionsUsed\":[\"MSFT_lod\"],"
           << "\"scene\":0,"
           << "\"scenes\":[{\"nodes\":[0]}],"
           << "\"nodes\":[";

        ss << "{\"mesh\":0";
        if (M > 1) {
            ss << ",\"extensions\":{\"MSFT_lod\":{\"ids\":[";
            for (size_t m = 1; m < M; ++m) {
                ss << m << (m + 1 < M ? "," : "");
            }
            ss << "]}}";
        }
        ss << "}";

        for (size_t m = 1; m < M; ++m) {
            ss << ",{\"mesh\":" << m << "}";
        }
        ss << "],";

        ss << "\"meshes\":[";
        for (size_t m = 0; m < M; ++m) {
            size_t accBase = m * 6;
            ss << (m > 0 ? "," : "")
               << "{\"primitives\":[{"
               << "\"attributes\":{"
               << "\"POSITION\":" << (accBase + 1) << ","
               << "\"NORMAL\":" << (accBase + 2) << ","
               << "\"TEXCOORD_0\":" << (accBase + 3) << ","
               << "\"COLOR_0\":" << (accBase + 4) << ","
               << "\"TANGENT\":" << (accBase + 5)
               << "},"
               << "\"indices\":" << (accBase + 0) << ","
               << "\"material\":0"
               << "}]}";
        }
        ss << "],";

        const auto& mat = lodMeshes[0].material;
        ss << "\"materials\":[{"
           << "\"name\":\"" << mat.name << "\","
           << "\"pbrMetallicRoughness\":{"
           << "\"baseColorFactor\":[" << mat.baseColorFactor.x << "," << mat.baseColorFactor.y << "," << mat.baseColorFactor.z << "," << mat.baseColorFactor.w << "],"
           << "\"metallicFactor\":" << mat.metallicFactor << ","
           << "\"roughnessFactor\":" << mat.roughnessFactor
           << "},"
           << "\"doubleSided\":true"
           << "}],";

        ss << "\"accessors\":[";
        for (size_t m = 0; m < M; ++m) {
            const auto& mo = meshOffsets[m];
            size_t bvBase = m * 6;
            if (m > 0) ss << ",";
            ss << "{\"bufferView\":" << (bvBase + 0) << ",\"componentType\":5125,\"count\":" << mo.idxCount << ",\"type\":\"SCALAR\"},"
               << "{\"bufferView\":" << (bvBase + 1) << ",\"componentType\":5126,\"count\":" << mo.posCount << ",\"type\":\"VEC3\",\"max\":[" << mo.maxX << "," << mo.maxY << "," << mo.maxZ << "],\"min\":[" << mo.minX << "," << mo.minY << "," << mo.minZ << "]},"
               << "{\"bufferView\":" << (bvBase + 2) << ",\"componentType\":5126,\"count\":" << mo.posCount << ",\"type\":\"VEC3\"},"
               << "{\"bufferView\":" << (bvBase + 3) << ",\"componentType\":5126,\"count\":" << mo.posCount << ",\"type\":\"VEC2\"},"
               << "{\"bufferView\":" << (bvBase + 4) << ",\"componentType\":5126,\"count\":" << mo.posCount << ",\"type\":\"VEC4\"},"
               << "{\"bufferView\":" << (bvBase + 5) << ",\"componentType\":5126,\"count\":" << mo.posCount << ",\"type\":\"VEC4\"}";
        }
        ss << "],";

        ss << "\"bufferViews\":[";
        for (size_t m = 0; m < M; ++m) {
            const auto& mo = meshOffsets[m];
            size_t bvBase = m * 6;
            if (m > 0) ss << ",";
            ss << "{\"buffer\":0,\"byteOffset\":" << mo.idxOffset << ",\"byteLength\":" << mo.idxBytes << ",\"target\":34963},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.posOffset << ",\"byteLength\":" << mo.posBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.normOffset << ",\"byteLength\":" << mo.normBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.uvOffset << ",\"byteLength\":" << mo.uvBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.colOffset << ",\"byteLength\":" << mo.colBytes << ",\"target\":34962},"
               << "{\"buffer\":0,\"byteOffset\":" << mo.tanOffset << ",\"byteLength\":" << mo.tanBytes << ",\"target\":34962}";
        }
        ss << "],";

        ss << "\"buffers\":[{\"byteLength\":" << binChunkLength << "}]"
           << "}";

        std::string jsonStr = ss.str();
        size_t jsonPadding = (4 - (jsonStr.size() % 4)) % 4;
        jsonStr.append(jsonPadding, ' ');

        uint32_t jsonChunkLength = static_cast<uint32_t>(jsonStr.size());
        uint32_t totalLength = 12 + 8 + jsonChunkLength + 8 + static_cast<uint32_t>(binChunkLength);

        std::vector<uint8_t> glb(totalLength);
        uint8_t* out = glb.data();

        // 12-byte header
        uint32_t magic = 0x46546C67; // "glTF"
        uint32_t version = 2;
        std::memcpy(out + 0, &magic, 4);
        std::memcpy(out + 4, &version, 4);
        std::memcpy(out + 8, &totalLength, 4);
        out += 12;

        // JSON Chunk header
        uint32_t jsonType = 0x4E4F534A; // "JSON"
        std::memcpy(out + 0, &jsonChunkLength, 4);
        std::memcpy(out + 4, &jsonType, 4);
        out += 8;
        std::memcpy(out, jsonStr.data(), jsonChunkLength);
        out += jsonChunkLength;

        // BIN Chunk header
        uint32_t binType = 0x004E4942; // "BIN\0"
        uint32_t binLen = static_cast<uint32_t>(binChunkLength);
        std::memcpy(out + 0, &binLen, 4);
        std::memcpy(out + 4, &binType, 4);
        out += 8;
        std::memcpy(out, binData.data(), binChunkLength);

        return glb;
    }

    static void streamLodChunk(
        const std::vector<ScratchboxMesh>& lodMeshes,
        const std::string& chunkId = "chunk-lod-0"
    ) {
        auto glb = serializeLodGlb(lodMeshes);
        if (glb.empty()) return;

        std::string name = chunkId.empty() ? lodMeshes[0].name : chunkId;
        std::string b64 = base64Encode(glb.data(), glb.size());
        std::cout << "\n===SCRATCHBOX_3D_CHUNK_START===\n";
        std::cout << "{\"id\":\"" << chunkId << "\",\"name\":\"" << name
                  << "\",\"vertexCount\":" << lodMeshes[0].vertices.size()
                  << ",\"indexCount\":" << lodMeshes[0].indices.size()
                  << ",\"isLod\":true"
                  << ",\"lodLevels\":" << lodMeshes.size()
                  << ",\"glbBase64\":\"" << b64 << "\"}\n";
        std::cout << "===SCRATCHBOX_3D_CHUNK_END===\n" << std::flush;
    }
};

// ============================================================================
// Zero-Dependency glTF 2.0 Binary (.glb) Reader
// ============================================================================

struct GlbJsonValue {
    enum Type { Null, Bool, Number, String, Array, Object } type{Null};
    bool b{false};
    double num{0.0};
    std::string str;
    std::vector<GlbJsonValue> arr;
    std::vector<std::pair<std::string, GlbJsonValue>> obj;

    const GlbJsonValue& operator[](const std::string& key) const {
        static GlbJsonValue nullVal;
        if (type != Object) return nullVal;
        for (const auto& kv : obj) {
            if (kv.first == key) return kv.second;
        }
        return nullVal;
    }

    const GlbJsonValue& operator[](size_t index) const {
        static GlbJsonValue nullVal;
        if (type != Array || index >= arr.size()) return nullVal;
        return arr[index];
    }

    bool has(const std::string& key) const {
        if (type != Object) return false;
        for (const auto& kv : obj) {
            if (kv.first == key) return true;
        }
        return false;
    }

    int asInt(int def = 0) const { return type == Number ? static_cast<int>(num) : def; }
    size_t asSizeT(size_t def = 0) const { return type == Number ? static_cast<size_t>(num) : def; }
    float asFloat(float def = 0.0f) const { return type == Number ? static_cast<float>(num) : def; }
    const std::string& asString(const std::string& def = "") const { return type == String ? str : def; }
    bool isNull() const { return type == Null; }
};

class GlbJsonParser {
    const char* p{nullptr};
    const char* end{nullptr};

    void skipWs() {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
    }

public:
    GlbJsonParser(const char* start, size_t len) : p(start), end(start + len) {}

    GlbJsonValue parse() {
        skipWs();
        return parseValue();
    }

private:
    GlbJsonValue parseValue() {
        skipWs();
        if (p >= end) return {};
        char c = *p;
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '"') return parseString();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') return parseNull();
        if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
        return {};
    }

    GlbJsonValue parseObject() {
        GlbJsonValue v;
        v.type = GlbJsonValue::Object;
        ++p; // skip '{'
        while (p < end) {
            skipWs();
            if (p >= end) break;
            if (*p == '}') { ++p; break; }
            if (*p == ',') { ++p; continue; }
            if (*p == '"') {
                std::string key = parseString().str;
                skipWs();
                if (p < end && *p == ':') ++p;
                GlbJsonValue val = parseValue();
                v.obj.push_back({std::move(key), std::move(val)});
            } else {
                ++p;
            }
        }
        return v;
    }

    GlbJsonValue parseArray() {
        GlbJsonValue v;
        v.type = GlbJsonValue::Array;
        ++p; // skip '['
        while (p < end) {
            skipWs();
            if (p >= end) break;
            if (*p == ']') { ++p; break; }
            if (*p == ',') { ++p; continue; }
            v.arr.push_back(parseValue());
        }
        return v;
    }

    GlbJsonValue parseString() {
        GlbJsonValue v;
        v.type = GlbJsonValue::String;
        ++p; // skip quote
        while (p < end && *p != '"') {
            if (*p == '\\' && p + 1 < end) {
                ++p;
                if (*p == '"' || *p == '\\' || *p == '/') v.str.push_back(*p);
                else if (*p == 'n') v.str.push_back('\n');
                else if (*p == 't') v.str.push_back('\t');
                else if (*p == 'r') v.str.push_back('\r');
                else v.str.push_back(*p);
            } else {
                v.str.push_back(*p);
            }
            ++p;
        }
        if (p < end && *p == '"') ++p;
        return v;
    }

    GlbJsonValue parseNumber() {
        GlbJsonValue v;
        v.type = GlbJsonValue::Number;
        const char* start = p;
        if (*p == '-') ++p;
        while (p < end && ((*p >= '0' && *p <= '9') || *p == '.' || *p == 'e' || *p == 'E' || *p == '+' || *p == '-')) {
            ++p;
        }
        v.num = std::strtod(start, nullptr);
        return v;
    }

    GlbJsonValue parseBool() {
        GlbJsonValue v;
        v.type = GlbJsonValue::Bool;
        if (p + 4 <= end && std::strncmp(p, "true", 4) == 0) {
            v.b = true;
            p += 4;
        } else if (p + 5 <= end && std::strncmp(p, "false", 5) == 0) {
            v.b = false;
            p += 5;
        }
        return v;
    }

    GlbJsonValue parseNull() {
        GlbJsonValue v;
        v.type = GlbJsonValue::Null;
        if (p + 4 <= end && std::strncmp(p, "null", 4) == 0) {
            p += 4;
        }
        return v;
    }
};

class GlbReader {
public:
    static ScratchboxMesh readGlb(const std::string& filePath) {
        std::ifstream file(filePath, std::ios::binary | std::ios::ate);
        if (!file.is_open()) return {};
        std::streamsize size = file.tellg();
        file.seekg(0, std::ios::beg);
        std::vector<uint8_t> data(static_cast<size_t>(size));
        if (!file.read(reinterpret_cast<char*>(data.data()), size)) return {};
        return parseGlb(data.data(), data.size());
    }

    static std::vector<ScratchboxMesh> readAllMeshes(const std::string& filePath) {
        std::ifstream file(filePath, std::ios::binary | std::ios::ate);
        if (!file.is_open()) return {};
        std::streamsize size = file.tellg();
        file.seekg(0, std::ios::beg);
        std::vector<uint8_t> data(static_cast<size_t>(size));
        if (!file.read(reinterpret_cast<char*>(data.data()), size)) return {};
        return parseAllMeshes(data.data(), data.size());
    }

    static ScratchboxMesh parseGlb(const uint8_t* data, size_t length) {
        auto meshes = parseAllMeshes(data, length);
        if (meshes.empty()) return {};
        if (meshes.size() == 1) return meshes[0];

        // Merge all submeshes into a unified ScratchboxMesh
        ScratchboxMesh unified;
        unified.name = meshes[0].name;
        for (const auto& m : meshes) {
            uint32_t baseIdx = static_cast<uint32_t>(unified.vertices.size());
            for (const auto& v : m.vertices) {
                unified.addVertex(v);
            }
            for (uint32_t idx : m.indices) {
                unified.indices.push_back(baseIdx + idx);
            }
        }
        return unified;
    }

    static std::vector<ScratchboxMesh> parseAllMeshes(const uint8_t* data, size_t length) {
        if (!data || length < 20) return {};

        // 1. Verify 12-byte header
        uint32_t magic = 0, version = 0, totalLength = 0;
        std::memcpy(&magic, data + 0, 4);
        std::memcpy(&version, data + 4, 4);
        std::memcpy(&totalLength, data + 8, 4);

        if (magic != 0x46546C67 || version != 2) return {};

        // 2. Parse Chunk 0 (JSON)
        uint32_t jsonChunkLen = 0, jsonChunkType = 0;
        std::memcpy(&jsonChunkLen, data + 12, 4);
        std::memcpy(&jsonChunkType, data + 16, 4);
        if (jsonChunkType != 0x4E4F534A) return {}; // 'JSON'

        if (12 + 8 + jsonChunkLen > length) return {};
        const char* jsonText = reinterpret_cast<const char*>(data + 20);

        GlbJsonParser parser(jsonText, jsonChunkLen);
        GlbJsonValue root = parser.parse();

        // 3. Locate Chunk 1 (BIN)
        size_t binHeaderOffset = 12 + 8 + jsonChunkLen;
        if (binHeaderOffset + 8 > length) return {};

        uint32_t binChunkLen = 0, binChunkType = 0;
        std::memcpy(&binChunkLen, data + binHeaderOffset, 4);
        std::memcpy(&binChunkType, data + binHeaderOffset + 4, 4);

        const uint8_t* binData = data + binHeaderOffset + 8;
        if (binHeaderOffset + 8 + binChunkLen > length) {
            binChunkLen = static_cast<uint32_t>(length - (binHeaderOffset + 8));
        }

        const auto& accessors = root["accessors"];
        const auto& bufferViews = root["bufferViews"];
        const auto& meshes = root["meshes"];

        auto getComponentCount = [](const std::string& type) -> int {
            if (type == "SCALAR") return 1;
            if (type == "VEC2") return 2;
            if (type == "VEC3") return 3;
            if (type == "VEC4") return 4;
            if (type == "MAT4") return 16;
            return 1;
        };

        auto readAccessorFloats = [&](int accIdx) -> std::vector<float> {
            if (accIdx < 0 || accIdx >= static_cast<int>(accessors.arr.size())) return {};
            const auto& acc = accessors[accIdx];
            size_t count = acc["count"].asSizeT(0);
            int compType = acc["componentType"].asInt(5126);
            std::string type = acc["type"].asString("SCALAR");
            int numComp = getComponentCount(type);

            int bvIdx = acc["bufferView"].asInt(-1);
            if (bvIdx < 0 || bvIdx >= static_cast<int>(bufferViews.arr.size())) return {};
            const auto& bv = bufferViews[bvIdx];

            size_t bvOffset = bv["byteOffset"].asSizeT(0);
            size_t accOffset = acc["byteOffset"].asSizeT(0);
            size_t totalOffset = bvOffset + accOffset;
            size_t stride = bv["byteStride"].asSizeT(0);

            size_t compSize = 4;
            if (compType == 5120 || compType == 5121) compSize = 1;
            else if (compType == 5122 || compType == 5123) compSize = 2;
            else if (compType == 5125 || compType == 5126) compSize = 4;

            if (stride == 0) stride = numComp * compSize;

            std::vector<float> result;
            result.resize(count * numComp);

            for (size_t i = 0; i < count; ++i) {
                const uint8_t* elemPtr = binData + totalOffset + i * stride;
                if (elemPtr + numComp * compSize > binData + binChunkLen) break;

                for (int c = 0; c < numComp; ++c) {
                    float val = 0.0f;
                    if (compType == 5126) { // FLOAT
                        std::memcpy(&val, elemPtr + c * 4, 4);
                    } else if (compType == 5125) { // UNSIGNED_INT
                        uint32_t u32 = 0;
                        std::memcpy(&u32, elemPtr + c * 4, 4);
                        val = static_cast<float>(u32);
                    } else if (compType == 5123) { // UNSIGNED_SHORT
                        uint16_t u16 = 0;
                        std::memcpy(&u16, elemPtr + c * 2, 2);
                        val = static_cast<float>(u16);
                    } else if (compType == 5121) { // UNSIGNED_BYTE
                        uint8_t u8 = elemPtr[c];
                        val = static_cast<float>(u8) / 255.0f; // normalized
                    }
                    result[i * numComp + c] = val;
                }
            }
            return result;
        };

        auto readAccessorIndices = [&](int accIdx) -> std::vector<uint32_t> {
            if (accIdx < 0 || accIdx >= static_cast<int>(accessors.arr.size())) return {};
            const auto& acc = accessors[accIdx];
            size_t count = acc["count"].asSizeT(0);
            int compType = acc["componentType"].asInt(5125);

            int bvIdx = acc["bufferView"].asInt(-1);
            if (bvIdx < 0 || bvIdx >= static_cast<int>(bufferViews.arr.size())) return {};
            const auto& bv = bufferViews[bvIdx];

            size_t bvOffset = bv["byteOffset"].asSizeT(0);
            size_t accOffset = acc["byteOffset"].asSizeT(0);
            size_t totalOffset = bvOffset + accOffset;
            size_t stride = bv["byteStride"].asSizeT(0);

            size_t compSize = (compType == 5125 ? 4 : (compType == 5123 ? 2 : 1));
            if (stride == 0) stride = compSize;

            std::vector<uint32_t> result;
            result.resize(count);

            for (size_t i = 0; i < count; ++i) {
                const uint8_t* elemPtr = binData + totalOffset + i * stride;
                if (elemPtr + compSize > binData + binChunkLen) break;

                if (compType == 5125) {
                    std::memcpy(&result[i], elemPtr, 4);
                } else if (compType == 5123) {
                    uint16_t u16 = 0;
                    std::memcpy(&u16, elemPtr, 2);
                    result[i] = u16;
                } else if (compType == 5121) {
                    result[i] = *elemPtr;
                }
            }
            return result;
        };

        std::vector<ScratchboxMesh> outMeshes;

        for (size_t m = 0; m < meshes.arr.size(); ++m) {
            const auto& meshObj = meshes[m];
            std::string meshName = meshObj["name"].asString("mesh_" + std::to_string(m));

            const auto& primitives = meshObj["primitives"];
            for (size_t p = 0; p < primitives.arr.size(); ++p) {
                const auto& prim = primitives[p];
                const auto& attrs = prim["attributes"];

                int posAccIdx = attrs["POSITION"].asInt(-1);
                if (posAccIdx < 0) continue;

                int normAccIdx = attrs["NORMAL"].asInt(-1);
                int uvAccIdx = attrs["TEXCOORD_0"].asInt(-1);
                int colAccIdx = attrs["COLOR_0"].asInt(-1);
                int tanAccIdx = attrs["TANGENT"].asInt(-1);
                int idxAccIdx = prim["indices"].asInt(-1);

                auto posFloats = readAccessorFloats(posAccIdx);
                auto normFloats = readAccessorFloats(normAccIdx);
                auto uvFloats = readAccessorFloats(uvAccIdx);
                auto colFloats = readAccessorFloats(colAccIdx);
                auto tanFloats = readAccessorFloats(tanAccIdx);
                auto indices = readAccessorIndices(idxAccIdx);

                size_t vertCount = posFloats.size() / 3;
                if (vertCount == 0) continue;

                ScratchboxMesh sMesh;
                sMesh.name = meshName;
                sMesh.vertices.reserve(vertCount);

                for (size_t v = 0; v < vertCount; ++v) {
                    math::Vec3 pos(posFloats[v * 3 + 0], posFloats[v * 3 + 1], posFloats[v * 3 + 2]);
                    math::Vec3 norm(0.0f, 1.0f, 0.0f);
                    if (v * 3 + 2 < normFloats.size()) {
                        norm = math::Vec3(normFloats[v * 3 + 0], normFloats[v * 3 + 1], normFloats[v * 3 + 2]);
                    }
                    math::Vec2 uv(0.0f, 0.0f);
                    if (v * 2 + 1 < uvFloats.size()) {
                        uv = math::Vec2(uvFloats[v * 2 + 0], uvFloats[v * 2 + 1]);
                    }
                    math::Vec4 col(1.0f, 1.0f, 1.0f, 1.0f);
                    if (v * 4 + 3 < colFloats.size()) {
                        col = math::Vec4(colFloats[v * 4 + 0], colFloats[v * 4 + 1], colFloats[v * 4 + 2], colFloats[v * 4 + 3]);
                    } else if (v * 3 + 2 < colFloats.size()) {
                        col = math::Vec4(colFloats[v * 3 + 0], colFloats[v * 3 + 1], colFloats[v * 3 + 2], 1.0f);
                    }
                    math::Vec4 tan(1.0f, 0.0f, 0.0f, 1.0f);
                    if (v * 4 + 3 < tanFloats.size()) {
                        tan = math::Vec4(tanFloats[v * 4 + 0], tanFloats[v * 4 + 1], tanFloats[v * 4 + 2], tanFloats[v * 4 + 3]);
                    }

                    sMesh.vertices.push_back({pos, norm, uv, col, tan});
                }

                if (!indices.empty()) {
                    sMesh.indices = std::move(indices);
                } else {
                    sMesh.indices.resize(vertCount);
                    for (size_t i = 0; i < vertCount; ++i) sMesh.indices[i] = static_cast<uint32_t>(i);
                }

                // If normals were completely missing, calculate them
                if (normFloats.empty() && sMesh.indices.size() >= 3) {
                    for (size_t i = 0; i + 2 < sMesh.indices.size(); i += 3) {
                        uint32_t i0 = sMesh.indices[i];
                        uint32_t i1 = sMesh.indices[i + 1];
                        uint32_t i2 = sMesh.indices[i + 2];
                        math::Vec3 p0 = sMesh.vertices[i0].position;
                        math::Vec3 p1 = sMesh.vertices[i1].position;
                        math::Vec3 p2 = sMesh.vertices[i2].position;
                        math::Vec3 fn = (p1 - p0).cross(p2 - p0).normalized();
                        sMesh.vertices[i0].normal = fn;
                        sMesh.vertices[i1].normal = fn;
                        sMesh.vertices[i2].normal = fn;
                    }
                }

                outMeshes.push_back(std::move(sMesh));
            }
        }

        return outMeshes;
    }
};

// ============================================================================
// Wavefront .OBJ Writer
// ============================================================================
class ObjWriter {
public:
    static bool writeToFile(const ScratchboxMesh& mesh, const std::string& filePath) {
        std::ofstream file(filePath);
        if (!file.is_open()) return false;

        file << "# Generated by Scratchbox Astro C++ Engine\n";
        file << "o " << mesh.name << "\n";

        for (const auto& v : mesh.vertices) {
            file << "v " << v.position.x << " " << v.position.y << " " << v.position.z << "\n";
        }
        for (const auto& v : mesh.vertices) {
            file << "vn " << v.normal.x << " " << v.normal.y << " " << v.normal.z << "\n";
        }
        for (const auto& v : mesh.vertices) {
            file << "vt " << v.uv.x << " " << v.uv.y << "\n";
        }

        for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
            uint32_t i0 = mesh.indices[i] + 1;
            uint32_t i1 = mesh.indices[i + 1] + 1;
            uint32_t i2 = mesh.indices[i + 2] + 1;
            file << "f " << i0 << "/" << i0 << "/" << i0 << " "
                 << i1 << "/" << i1 << "/" << i1 << " "
                 << i2 << "/" << i2 << "/" << i2 << "\n";
        }

        return true;
    }
};

} // namespace io
} // namespace scratchbox

#endif // SCRATCHBOX_IO_HPP
