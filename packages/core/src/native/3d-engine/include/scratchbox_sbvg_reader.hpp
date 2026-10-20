/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SBVG_READER_HPP
#define SCRATCHBOX_SBVG_READER_HPP

/**
 * Reader for the .sbvg cluster LOD files scratchbox_virtual_geometry.hpp writes (versions 2 and 3),
 * and the per-cluster LOD cut a renderer takes from one.
 *
 * The cut rule is the one in cluster-selection.ts and VirtualGeometryRenderer's cull pass: a cluster
 * is drawn when its projected self error is within the pixel threshold and its projected parent error
 * is not. Frustum and normal-cone culling are not applied here: a ray tracer needs the geometry behind
 * the camera and the back faces for shadow and bounce rays.
 */

#include "scratchbox_virtual_geometry.hpp"
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace sbvg {

struct ClusterRecord {
    uint32_t refBase{0};
    uint32_t refCount{0};
    uint32_t triBase{0};
    uint32_t triCount{0};
    uint32_t level{0};
    uint32_t group{0};
    float bounds[4]{0, 0, 0, 0};
    float coneAxis[3]{0, 0, 1};
    float coneCutoff{1.0f};
    float selfLod[4]{0, 0, 0, 0};
    float selfError{0.0f};
    float parentLod[4]{0, 0, 0, 0};
    float parentError{vgeo::kRootParentError};
};

struct File {
    uint32_t version{0};
    uint32_t levelCount{0};
    uint32_t sourceTriangles{0};
    uint32_t leafTriangleCount{0};
    uint32_t skippedPrimitives{0};
    uint32_t droppedDegenerate{0};
    /** Length of the source glTF's materials array (0 in version 2 files). */
    uint32_t materialCount{0};
    float aabbMin[3]{0, 0, 0};
    float aabbMax[3]{0, 0, 0};
    /** World position the stored vertices are relative to. */
    double origin[3]{0, 0, 0};
    std::vector<ClusterRecord> clusters;
    /** position xyz, normal xyz, uv per vertex (kSbvgVertexFloats), relative to origin; uv is (0, 0) in version 2 files. */
    std::vector<float> vertices;
    /** Global vertex index per cluster-local vertex. */
    std::vector<uint32_t> refs;
    /** Cluster-local corner indices packed i0 | i1 << 8 | i2 << 16. */
    std::vector<uint32_t> tris;
    /** glTF material index per triangle, or vgeo::kNoMaterial (always kNoMaterial in version 2 files). */
    std::vector<uint32_t> materials;

    uint32_t vertexCount() const { return static_cast<uint32_t>(vertices.size() / vgeo::kSbvgVertexFloats); }
};

struct FormatError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

inline File readFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw FormatError("cannot open " + path);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (bytes.size() < vgeo::kSbvgHeaderBytes) throw FormatError(path + ": shorter than an .sbvg header");
    auto word = [&](size_t index) {
        uint32_t w;
        std::memcpy(&w, bytes.data() + index * 4, 4);
        return w;
    };
    auto fword = [&](size_t index) {
        float f;
        std::memcpy(&f, bytes.data() + index * 4, 4);
        return f;
    };
    if (word(0) != vgeo::kSbvgMagic) throw FormatError(path + ": not an .sbvg file");
    File file;
    file.version = word(1);
    if (file.version != 2 && file.version != 3) {
        throw FormatError(path + ": .sbvg version " + std::to_string(file.version) + " (this reader handles versions 2 and 3)");
    }
    const uint32_t fileVertexFloats = file.version >= 3 ? vgeo::kSbvgVertexFloats : 6;
    const bool hasMaterials = file.version >= 3;
    const uint32_t headerBytes = word(2);
    file.levelCount = word(3);
    const uint32_t vertexCount = word(4), clusterCount = word(5), refCount = word(6), triCount = word(7);
    file.leafTriangleCount = word(8);
    file.sourceTriangles = word(9);
    for (int i = 0; i < 3; ++i) {
        file.aabbMin[i] = fword(12 + i);
        file.aabbMax[i] = fword(15 + i);
    }
    std::memcpy(file.origin, bytes.data() + 18 * 4, 24);
    file.skippedPrimitives = word(24);
    file.droppedDegenerate = word(25);
    file.materialCount = hasMaterials ? word(26) : 0;
    if (headerBytes != vgeo::kSbvgHeaderBytes + file.levelCount * vgeo::kSbvgLevelWords * 4 || bytes.size() < headerBytes) {
        throw FormatError(path + ": header size does not match its level count");
    }
    file.clusters.reserve(clusterCount);
    file.vertices.reserve(static_cast<size_t>(vertexCount) * vgeo::kSbvgVertexFloats);
    file.refs.reserve(refCount);
    file.tris.reserve(triCount);
    file.materials.reserve(triCount);
    for (uint32_t level = 0; level < file.levelCount; ++level) {
        const size_t row = vgeo::kSbvgHeaderBytes / 4 + static_cast<size_t>(level) * vgeo::kSbvgLevelWords;
        const uint32_t levelClusters = word(row + 2), levelVertices = word(row + 4), levelRefs = word(row + 6), levelTris = word(row + 8);
        const uint64_t offset = uint64_t(word(row + 9)) | (uint64_t(word(row + 10)) << 32);
        const uint64_t length = uint64_t(word(row + 11)) | (uint64_t(word(row + 12)) << 32);
        const uint64_t expected = uint64_t(levelClusters) * vgeo::kSbvgClusterWords * 4 + uint64_t(levelVertices) * fileVertexFloats * 4
                                + uint64_t(levelRefs) * 4 + uint64_t(levelTris) * 4 * (hasMaterials ? 2 : 1);
        if (offset + length > bytes.size() || length != expected) throw FormatError(path + ": level block " + std::to_string(level) + " is truncated");
        if (word(row + 1) != file.clusters.size() || word(row + 3) != file.vertexCount() || word(row + 5) != file.refs.size() || word(row + 7) != file.tris.size()) {
            throw FormatError(path + ": level block " + std::to_string(level) + " is out of order");
        }
        size_t w = offset / 4;
        for (uint32_t c = 0; c < levelClusters; ++c, w += vgeo::kSbvgClusterWords) {
            ClusterRecord rec;
            rec.refBase = word(w);
            rec.refCount = word(w + 1);
            rec.triBase = word(w + 2);
            rec.triCount = word(w + 3);
            rec.level = word(w + 4);
            rec.group = word(w + 5);
            float f[13];
            std::memcpy(f, bytes.data() + (w + 8) * 4, sizeof(f));
            std::memcpy(rec.bounds, f, 16);
            std::memcpy(rec.coneAxis, f + 4, 12);
            rec.coneCutoff = f[7];
            std::memcpy(rec.selfLod, f + 8, 16);
            rec.selfError = f[12];
            float pf[5];
            std::memcpy(pf, bytes.data() + (w + 24) * 4, sizeof(pf));
            std::memcpy(rec.parentLod, pf, 16);
            rec.parentError = pf[4];
            file.clusters.push_back(rec);
        }
        for (uint32_t v = 0; v < levelVertices; ++v, w += fileVertexFloats) {
            float f[vgeo::kSbvgVertexFloats] = {0, 0, 0, 0, 0, 0, 0, 0};
            std::memcpy(f, bytes.data() + w * 4, fileVertexFloats * 4);
            file.vertices.insert(file.vertices.end(), f, f + vgeo::kSbvgVertexFloats);
        }
        for (uint32_t r = 0; r < levelRefs; ++r) file.refs.push_back(word(w++));
        for (uint32_t t = 0; t < levelTris; ++t) file.tris.push_back(word(w++));
        if (hasMaterials) {
            for (uint32_t t = 0; t < levelTris; ++t) file.materials.push_back(word(w++));
        } else {
            file.materials.insert(file.materials.end(), levelTris, vgeo::kNoMaterial);
        }
    }
    if (file.clusters.size() != clusterCount || file.vertexCount() != vertexCount || file.refs.size() != refCount || file.tris.size() != triCount) {
        throw FormatError(path + ": header counts do not match the level blocks");
    }
    for (const ClusterRecord& c : file.clusters) {
        if (uint64_t(c.refBase) + c.refCount > file.refs.size() || uint64_t(c.triBase) + c.triCount > file.tris.size()) throw FormatError(path + ": cluster references past the end of the file");
        for (uint32_t r = 0; r < c.refCount; ++r) {
            if (file.refs[c.refBase + r] >= vertexCount) throw FormatError(path + ": vertex reference past the vertex table");
        }
        for (uint32_t t = 0; t < c.triCount; ++t) {
            const uint32_t packed = file.tris[c.triBase + t];
            if ((packed & 0xFF) >= c.refCount || ((packed >> 8) & 0xFF) >= c.refCount || ((packed >> 16) & 0xFF) >= c.refCount) throw FormatError(path + ": triangle corner past its cluster's vertices");
            const uint32_t material = file.materials[c.triBase + t];
            if (material != vgeo::kNoMaterial && material >= file.materialCount) throw FormatError(path + ": triangle material past the material count");
        }
    }
    return file;
}

struct CutParams {
    /** Eye position relative to the file's origin. */
    float eye[3]{0, 0, 0};
    /** Pixels per unit of error at distance 1: viewport height / (2 tan(fovY / 2)). */
    float lodScale{1.0f};
    /** A LOD sphere closer than this (or containing the eye) always refines. */
    float near{0.1f};
    float thresholdPx{1.0f};
    /** Finest level to use; clusters of that level are leaves. */
    uint32_t finestLevel{0};
};

/** Projected screen-space error of a LOD sphere in pixels (1e30 for "always refine"). */
inline float projectedLodError(const float sphere[4], float error, const float eye[3], float lodScale, float near) {
    if (error <= 0.0f) return 0.0f;
    if (error >= 1e37f) return 1e30f;
    const float dx = sphere[0] - eye[0], dy = sphere[1] - eye[1], dz = sphere[2] - eye[2];
    const float d = std::sqrt(dx * dx + dy * dy + dz * dz) - sphere[3];
    if (d <= near) return 1e30f;
    return (error * lodScale) / d;
}

inline bool clusterSelected(const ClusterRecord& c, const CutParams& p) {
    if (c.level < p.finestLevel) return false;
    if (projectedLodError(c.parentLod, c.parentError, p.eye, p.lodScale, p.near) <= p.thresholdPx) return false;
    return c.level == p.finestLevel || projectedLodError(c.selfLod, c.selfError, p.eye, p.lodScale, p.near) <= p.thresholdPx;
}

struct Cut {
    std::vector<uint32_t> clusterIds;
    /** Three global vertex indices per triangle. */
    std::vector<uint32_t> indices;
    /** glTF material index per triangle, or vgeo::kNoMaterial. */
    std::vector<uint32_t> materials;
    uint32_t triangleCount() const { return static_cast<uint32_t>(indices.size() / 3); }
};

inline Cut selectCut(const File& file, const CutParams& params) {
    Cut cut;
    for (uint32_t id = 0; id < file.clusters.size(); ++id) {
        const ClusterRecord& c = file.clusters[id];
        if (!clusterSelected(c, params)) continue;
        cut.clusterIds.push_back(id);
        for (uint32_t t = 0; t < c.triCount; ++t) {
            const uint32_t packed = file.tris[c.triBase + t];
            cut.indices.push_back(file.refs[c.refBase + (packed & 0xFF)]);
            cut.indices.push_back(file.refs[c.refBase + ((packed >> 8) & 0xFF)]);
            cut.indices.push_back(file.refs[c.refBase + ((packed >> 16) & 0xFF)]);
            cut.materials.push_back(file.materials[c.triBase + t]);
        }
    }
    return cut;
}

} // namespace sbvg
} // namespace scratchbox

#endif // SCRATCHBOX_SBVG_READER_HPP
