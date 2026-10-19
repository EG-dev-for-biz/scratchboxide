/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_STAGED_GLB_HPP
#define SCRATCHBOX_STAGED_GLB_HPP

/**
 * The staged layer GLB writer: one glTF 2.0 binary per committed stage of a staged location build, whose nodes carry
 * what the generator knows about how they were made (the contract in
 * packages/core/src/common/spatial/staged-location-contracts.ts, StagedNodeExtras and StagedGlbRootExtras).
 *
 *   - one node per StagedNode, holding one mesh of TRIANGLES (mode 4) and/or LINES (mode 1) primitives;
 *   - per primitive: POSITION, NORMAL (triangles; computed area-weighted when the caller gives none), COLOR_0 (optional,
 *     VEC4 UNSIGNED_BYTE normalised), `_REVEAL` (optional, VEC2 UNSIGNED_SHORT normalised: x = item order in the node,
 *     y = order inside the item, the generator's real build order) and `_DISP` (optional, VEC3 FLOAT metres: the
 *     host-surface-to-final displacement the reveal scales from 0 to 1), TEXCOORD_0 (optional, VEC2 FLOAT: texture
 *     coordinates, e.g. a tree's wood in bark-texture tiles) and `_LEAF` (optional, VEC2 UNSIGNED_SHORT normalised: a leaf
 *     card's atlas pick and whether the vertex is on a blade); library meshes carry the same optional attributes;
 *   - node extras: the caller's JSON object (it must hold `sb`, the StagedNodeExtras), copied verbatim;
 *   - one studio clay material; the root extras (StagedGlbRootExtras `sb`, the frame beside it) are the document's and
 *     the scene's extras (see WriteOptions::rootExtrasJson), never a node's.
 *
 * Every byte is run-independent: what depends on a run (object ids, crossfades, download order) lives in the server's
 * StagedLayer, never here, so a cached GLB is correct in every run that reuses it.
 *
 * Quantisation (WriteOptions::quantize): KHR_mesh_quantization, which three's GLTFLoader reads natively. Each node's
 * positions are stored as SHORT normalised over the node's own bounding cube (node translation = its centre, uniform
 * node scale = its half extent, so normals need no correction), normals as BYTE normalised, and indices as UNSIGNED_SHORT
 * wherever a primitive has fewer than 65,535 vertices. The largest position and normal error of the written file
 * (dequantised exactly as the loader does, against the float values given) is measured and returned, and written to
 * asset.extras.scratchbox.quantization; the write fails when it exceeds WriteOptions::maxPositionErrorM. `_DISP` is in
 * metres of the tile frame, so a node carrying it is never quantised (the call fails instead of rescaling it).
 *
 * Normalised orders: rankUnit(rank, n) = rank / max(1, n - 1), so a single item is 0, never NaN.
 */

#include "scratchbox_math.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <functional>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace staged_glb {

using math::Vec3;

class StagedGlbError : public std::runtime_error {
public:
    explicit StagedGlbError(const std::string& message) : std::runtime_error(message) {}
};

// ============================================================================================
// JSON text (a small escaping writer; the extras are built from these)
// ============================================================================================

namespace json {

/** A JSON number: shortest round-tripping text for a double; non-finite values are refused (JSON has none). */
inline std::string num(double v) {
    if (!std::isfinite(v)) throw StagedGlbError("a non-finite number cannot be written to JSON");
    if (v == 0.0) return "0";
    char buf[40];
    for (int precision = 6; precision <= 17; ++precision) {
        std::snprintf(buf, sizeof(buf), "%.*g", precision, v);
        if (std::strtod(buf, nullptr) == v) break;
    }
    return buf;
}

inline std::string integer(long long v) { return std::to_string(v); }

inline std::string str(const std::string& v) {
    std::string o = "\"";
    for (char c : v) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
                    o += buf;
                } else {
                    o += c;
                }
        }
    }
    return o + "\"";
}

inline std::string boolean(bool v) { return v ? "true" : "false"; }

inline std::string vec3(const Vec3& v) { return "[" + num(v.x) + "," + num(v.y) + "," + num(v.z) + "]"; }

/** An object built member by member, in insertion order. Values are raw JSON text. */
class Object {
public:
    Object& raw(const std::string& key, const std::string& rawJson) {
        members_ += (members_.empty() ? "" : ",") + str(key) + ":" + rawJson;
        return *this;
    }
    Object& s(const std::string& key, const std::string& value) { return raw(key, str(value)); }
    Object& n(const std::string& key, double value) {
        if (!std::isfinite(value)) throw StagedGlbError("the number '" + key + "' is not finite and cannot be written to JSON");
        return raw(key, num(value));
    }
    Object& i(const std::string& key, long long value) { return raw(key, integer(value)); }
    Object& b(const std::string& key, bool value) { return raw(key, boolean(value)); }
    Object& nul(const std::string& key) { return raw(key, "null"); }
    bool empty() const { return members_.empty(); }
    std::string text() const { return "{" + members_ + "}"; }
private:
    std::string members_;
};

inline std::string array(const std::vector<std::string>& items) {
    std::string o = "[";
    for (size_t k = 0; k < items.size(); ++k) o += (k ? "," : "") + items[k];
    return o + "]";
}

} // namespace json

// ============================================================================================
// Extras (StagedNodeExtras / StagedGlbRootExtras), as the contract has them
// ============================================================================================

struct SourceRef { std::string kind, id, note; };

struct Residual {
    double rmsM{0}, p50M{0}, p95M{0}, maxM{0};
    long long samples{0};
    double areaM2{0};
    double inlierFraction{std::numeric_limits<double>::quiet_NaN()};
    double supportFraction{std::numeric_limits<double>::quiet_NaN()};
    std::string toJson() const {
        json::Object o;
        o.n("rmsM", rmsM).n("p50M", p50M).n("p95M", p95M).n("maxM", maxM).i("samples", samples).n("areaM2", areaM2);
        if (std::isfinite(inlierFraction)) o.n("inlierFraction", inlierFraction);
        if (std::isfinite(supportFraction)) o.n("supportFraction", supportFraction);
        return o.text();
    }
};

/** ProvenanceRecord. A label is an open diagnostic string; nothing here branches on it. */
struct Provenance {
    std::string label;
    bool measuredGeometry{true};
    std::string method;
    std::vector<SourceRef> sources;
    double confidence{std::numeric_limits<double>::quiet_NaN()};  // required when measuredGeometry is false
    bool hasResidual{false};
    Residual residual;
    std::string note;
    std::vector<std::pair<std::string, double>> inferred;
    std::string toJson() const {
        if (!measuredGeometry && !std::isfinite(confidence)) throw StagedGlbError("provenance '" + label + "' is not measured geometry and has no confidence");
        json::Object o;
        o.s("label", label).b("measuredGeometry", measuredGeometry).s("method", method);
        std::vector<std::string> src;
        for (const auto& r : sources) {
            json::Object so;
            so.s("kind", r.kind).s("id", r.id);
            if (!r.note.empty()) so.s("note", r.note);
            src.push_back(so.text());
        }
        o.raw("sources", json::array(src));
        if (std::isfinite(confidence)) o.n("confidence", confidence);
        if (hasResidual) o.raw("residual", residual.toJson());
        if (!note.empty()) o.s("note", note);
        if (!inferred.empty()) {
            json::Object inf;
            for (const auto& [k, v] : inferred) inf.n(k, v);
            o.raw("inferred", inf.text());
        }
        return o.text();
    }
};

/** StagedNodeExtras.sb. revealKind is diagnostic; the viewport reads the attributes and numbers. */
struct NodeExtras {
    std::string stage;
    Provenance provenance;
    long long buildOrder{0};
    long long buildCount{1};
    std::string revealKind{"appear"};
    bool revealAttribute{false};   // the node's vertices carry _REVEAL
    bool displacement{false};      // ... and _DISP
    double durationShare{1.0};
    bool hasSweep{false};
    double sweepCarrierLengthM{0};
    bool sweepClosed{false};
    // ids (empty / < 0: absent)
    std::string primitiveId, surfaceId, slotId, elementId, leafId, degradationId;
    long long crownId{-1};
    std::vector<std::string> replacesSurfaceIds;
    bool hasFitError{false};
    Residual fitError;
    long long vertices{0}, triangles{0}, lines{-1};

    /** The `sb` object. */
    std::string sbJson() const {
        if (buildCount < 1 || buildOrder < 0 || buildOrder >= buildCount) throw StagedGlbError("node buildOrder " + std::to_string(buildOrder) + " is outside [0, " + std::to_string(buildCount) + ")");
        if (!(durationShare > 0.0 && durationShare <= 1.0)) throw StagedGlbError("node durationShare must lie in (0, 1]");
        json::Object o;
        o.s("schema", "scratchbox.staged-node/2").s("stage", stage).raw("provenance", provenance.toJson())
            .i("buildOrder", buildOrder).i("buildCount", buildCount).s("revealKind", revealKind);
        json::Object rv;
        if (revealAttribute) rv.s("attribute", "_REVEAL"); else rv.nul("attribute");
        if (displacement) rv.s("displacement", "_DISP"); else rv.nul("displacement");
        rv.n("durationShare", durationShare);
        o.raw("reveal", rv.text());
        if (hasSweep) {
            json::Object sw;
            sw.n("carrierLengthM", sweepCarrierLengthM).b("closed", sweepClosed).s("tAttribute", "_REVEAL.y");
            o.raw("sweep", sw.text());
        }
        json::Object ids;
        if (!primitiveId.empty()) ids.s("primitiveId", primitiveId);
        if (!surfaceId.empty()) ids.s("surfaceId", surfaceId);
        if (!slotId.empty()) ids.s("slotId", slotId);
        if (!elementId.empty()) ids.s("elementId", elementId);
        if (crownId >= 0) ids.i("crownId", crownId);
        if (!leafId.empty()) ids.s("leafId", leafId);
        if (!degradationId.empty()) ids.s("degradationId", degradationId);
        o.raw("ids", ids.text());
        if (!replacesSurfaceIds.empty()) {
            std::vector<std::string> r;
            for (const auto& s : replacesSurfaceIds) r.push_back(json::str(s));
            o.raw("replacesSurfaceIds", json::array(r));
        }
        if (hasFitError) o.raw("fitError", fitError.toJson());
        json::Object c;
        c.i("vertices", vertices).i("triangles", triangles);
        if (lines >= 0) c.i("lines", lines);
        o.raw("counts", c.text());
        return o.text();
    }

    /** A node extras object: `sb` plus any members of the caller's own (raw JSON text, comma-separated pairs). */
    std::string toJson(const std::string& extraMembers = std::string()) const {
        return "{" + (extraMembers.empty() ? std::string() : extraMembers + ",") + "\"sb\":" + sbJson() + "}";
    }
};

/** StagedGlbRootExtras.sb (the crawler's frame extras, when any, are passed beside it as extra members). */
inline std::string rootExtrasJson(const std::string& stage, const std::string& stageKey, const std::string& frame,
                                  const std::string& buildingId = std::string(), const std::string& extraMembers = std::string()) {
    json::Object sb;
    sb.s("schema", "scratchbox.staged-glb/2").s("stage", stage).s("stageKey", stageKey);
    if (!buildingId.empty()) sb.s("buildingId", buildingId);
    sb.s("frame", frame);
    return "{" + (extraMembers.empty() ? std::string() : extraMembers + ",") + "\"sb\":" + sb.text() + "}";
}

// ============================================================================================
// Geometry handed to the writer
// ============================================================================================

/** rank / max(1, n - 1): a normalised order that is 0 for a single item, never NaN. */
inline float rankUnit(size_t rank, size_t n) {
    return n <= 1 ? 0.0f : static_cast<float>(static_cast<double>(rank) / static_cast<double>(n - 1));
}

/** A 0..1 value as a normalised unsigned short (clamped, rounded to nearest). */
inline uint16_t unorm16(float v) {
    const double c = std::clamp(static_cast<double>(v), 0.0, 1.0);
    return static_cast<uint16_t>(std::lround(c * 65535.0));
}

struct StagedPrimitive {
    int mode{4};                                     // 4 TRIANGLES, 1 LINES
    std::vector<Vec3> positions;                     // tile frame, metres
    std::vector<Vec3> normals;                       // TRIANGLES: per vertex (computed when empty)
    std::vector<uint32_t> indices;                   // 3 per triangle, or 2 per line segment
    std::vector<std::array<uint8_t, 4>> colors;      // optional COLOR_0 (RGBA 0..255)
    std::vector<std::array<float, 2>> reveal;        // optional _REVEAL (0..1 each)
    std::vector<Vec3> disp;                          // optional _DISP (metres)
    std::vector<std::array<float, 2>> uvs;           // optional TEXCOORD_0 (float)
    std::vector<std::array<float, 2>> leaf;          // optional _LEAF (each in [0, 1], written UNSIGNED_SHORT normalised)
    // Reuses the buffers of a primitive written earlier (nothing is written again): the node named here must be in the same
    // frameGroup, and `reuseIndex` counts that node's written primitives. All other members are then empty.
    std::string reuseNode;
    size_t reuseIndex{0};
};

/** Copies of a library mesh (EXT_mesh_gpu_instancing), in the tile frame; the writer expresses them in the parent node's frame. */
struct StagedInstances {
    std::string libraryMesh;                         // WriteOptions::library name
    std::vector<Vec3> translations;
    std::vector<std::array<float, 4>> rotations;     // x, y, z, w (unit quaternions)
    std::vector<Vec3> scales;
    std::vector<std::array<float, 2>> reveal;        // optional `_REVEAL` per instance (VEC2 UNSIGNED_SHORT normalised)
    std::string sameDataAs;                          // the name of an earlier node whose instance data this one reuses (nothing is written again)
};

struct StagedNode {
    std::string name;
    std::vector<StagedPrimitive> primitives;
    std::string extrasJson;                          // the node's extras object; a top-level node must hold "sb"; empty: none
    std::vector<StagedNode> children;                // child nodes (level-of-detail nodes of a tree, a tree's instanced leaf clusters)
    std::string meshFrom;                            // the name of an earlier node whose mesh (and quantisation frame) this node shares
    std::string frameGroup;                          // nodes with the same group share one quantisation cube (over all their own primitives), so they can share primitives
    std::vector<StagedInstances> instances;          // at most one: the node instances a library mesh (and then holds no primitives)
};

/** A mesh written once and instanced by nodes (always float positions: it is small, and instances carry its scale). */
struct StagedLibraryMesh {
    std::string name;
    StagedPrimitive primitive;
};

struct WriteOptions {
    std::string generator{"Scratchbox staged GLB writer"};
    std::string rootName{"staged_layer"};
    // The layer's root extras (StagedGlbRootExtras, beside any frame extras): written as the glTF document's `extras`,
    // where the tile crawler keeps its frame, and as the scene's, so three's GLTFLoader gives them to both gltf.userData
    // and gltf.scene.userData. Never on a node: every node with extras.sb is one item of the layer. Empty: none.
    std::string rootExtrasJson;
    std::array<double, 4> clayColor{0.55, 0.57, 0.6, 1.0};
    double clayRoughness{0.85};
    std::vector<StagedLibraryMesh> library;          // meshes nodes instance (StagedNode::instances)
    bool quantize{false};                            // KHR_mesh_quantization (see the file comment)
    double maxPositionErrorM{0.01};                  // the largest position error a quantised write may have
};

struct WriteReport {
    size_t bytes{0};
    size_t nodes{0}, triangles{0}, lineSegments{0}, vertices{0};   // nodes: the top-level ones; triangles and vertices: stored once
    size_t instances{0};                             // instances written (EXT_mesh_gpu_instancing)
    size_t instancedTriangles{0};                    // triangles those instances draw
    size_t jsonBytes{0}, binBytes{0};
    bool quantized{false};
    double maxPositionErrorM{0};                     // measured on the written values (0 unquantised)
    double maxNormalErrorDeg{0};
    size_t u16IndexPrimitives{0}, u32IndexPrimitives{0};
};

namespace detail {

struct Builder {
    std::vector<uint8_t> bin;
    std::vector<std::string> views, accessors;

    int addView(const void* data, size_t bytes, int target, size_t stride = 0) {
        while (bin.size() % 4) bin.push_back(0);
        const size_t offset = bin.size();
        const auto* p = static_cast<const uint8_t*>(data);
        bin.insert(bin.end(), p, p + bytes);
        json::Object v;
        v.i("buffer", 0).i("byteOffset", static_cast<long long>(offset)).i("byteLength", static_cast<long long>(bytes));
        if (stride) v.i("byteStride", static_cast<long long>(stride));
        if (target) v.i("target", target);
        views.push_back(v.text());
        return static_cast<int>(views.size()) - 1;
    }

    /** Reserves a buffer view's place in the list now (its accessors can refer to it), to be filled later by fillView. */
    int reserveView() {
        views.push_back(std::string());
        return static_cast<int>(views.size()) - 1;
    }
    void fillView(int index, const void* data, size_t bytes) {
        while (bin.size() % 4) bin.push_back(0);
        const size_t offset = bin.size();
        const auto* p = static_cast<const uint8_t*>(data);
        bin.insert(bin.end(), p, p + bytes);
        json::Object v;
        v.i("buffer", 0).i("byteOffset", static_cast<long long>(offset)).i("byteLength", static_cast<long long>(bytes));
        views[static_cast<size_t>(index)] = v.text();
    }

    /** An accessor into a view at a byte offset into it. */
    int addAccessorAt(int view, size_t byteOffset, int componentType, size_t count, const char* type, bool normalized) {
        json::Object a;
        a.i("bufferView", view).i("byteOffset", static_cast<long long>(byteOffset)).i("componentType", componentType).i("count", static_cast<long long>(count)).s("type", type);
        if (normalized) a.b("normalized", true);
        accessors.push_back(a.text());
        return static_cast<int>(accessors.size()) - 1;
    }

    int addAccessor(int view, int componentType, size_t count, const char* type, bool normalized,
                    const std::vector<double>* lo = nullptr, const std::vector<double>* hi = nullptr) {
        json::Object a;
        a.i("bufferView", view).i("componentType", componentType).i("count", static_cast<long long>(count)).s("type", type);
        if (normalized) a.b("normalized", true);
        if (lo && hi) {
            std::vector<std::string> l, h;
            for (double v : *lo) l.push_back(json::num(v));
            for (double v : *hi) h.push_back(json::num(v));
            a.raw("min", json::array(l)).raw("max", json::array(h));
        }
        accessors.push_back(a.text());
        return static_cast<int>(accessors.size()) - 1;
    }

    std::vector<uint8_t> finish(std::string jsonText) {
        while (bin.size() % 4) bin.push_back(0);
        while (jsonText.size() % 4) jsonText.push_back(' ');
        std::vector<uint8_t> out;
        out.reserve(28 + jsonText.size() + bin.size());
        auto u32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xFF)); };
        const size_t total = 12 + 8 + jsonText.size() + (bin.empty() ? 0 : 8 + bin.size());
        if (total > 0xFFFFFFFFull) throw StagedGlbError("the GLB would exceed 4 GB");
        u32(0x46546C67);
        u32(2);
        u32(static_cast<uint32_t>(total));
        u32(static_cast<uint32_t>(jsonText.size()));
        u32(0x4E4F534A);
        out.insert(out.end(), jsonText.begin(), jsonText.end());
        if (!bin.empty()) {
            u32(static_cast<uint32_t>(bin.size()));
            u32(0x004E4942);
            out.insert(out.end(), bin.begin(), bin.end());
        }
        return out;
    }
};

/** Area-weighted vertex normals of a triangle list (a vertex on no triangle points up). */
inline std::vector<Vec3> vertexNormals(const std::vector<Vec3>& p, const std::vector<uint32_t>& idx) {
    std::vector<Vec3> n(p.size(), Vec3(0, 0, 0));
    for (size_t t = 0; t + 2 < idx.size(); t += 3) {
        const Vec3 f = (p[idx[t + 1]] - p[idx[t]]).cross(p[idx[t + 2]] - p[idx[t]]);
        for (int j = 0; j < 3; ++j) n[idx[t + static_cast<size_t>(j)]] += f;
    }
    for (auto& v : n) {
        const float l = v.length();
        v = l > 1e-12f ? v / l : Vec3(0, 1, 0);
    }
    return n;
}

inline int16_t snorm16(double v) { return static_cast<int16_t>(std::clamp(std::lround(v * 32767.0), -32767L, 32767L)); }
inline int8_t snorm8(double v) { return static_cast<int8_t>(std::clamp(std::lround(v * 127.0), -127L, 127L)); }
/** What three's GLTFLoader reads back from a normalised signed value: max(c / (2^(bits-1) - 1), -1). */
inline double unSnorm16(int16_t q) { return std::max(static_cast<double>(q) / 32767.0, -1.0); }
inline double unSnorm8(int8_t q) { return std::max(static_cast<double>(q) / 127.0, -1.0); }

/** TEXCOORD_0 (float) and `_LEAF` (unorm16) of a primitive, when it has them. */
inline void writeTexAttributes(Builder& gb, json::Object& attrs, const StagedPrimitive& pr, size_t nv, const std::string& who) {
    if (!pr.uvs.empty()) {
        if (pr.uvs.size() != nv) throw StagedGlbError(who + ": " + std::to_string(pr.uvs.size()) + " TEXCOORD_0 values for " + std::to_string(nv) + " vertices");
        std::vector<float> f(nv * 2);
        for (size_t v = 0; v < nv; ++v) {
            if (!std::isfinite(pr.uvs[v][0]) || !std::isfinite(pr.uvs[v][1])) throw StagedGlbError(who + " has a non-finite TEXCOORD_0 value");
            f[v * 2] = pr.uvs[v][0];
            f[v * 2 + 1] = pr.uvs[v][1];
        }
        attrs.i("TEXCOORD_0", gb.addAccessor(gb.addView(f.data(), f.size() * 4, 34962), 5126, nv, "VEC2", false));
    }
    if (!pr.leaf.empty()) {
        if (pr.leaf.size() != nv) throw StagedGlbError(who + ": " + std::to_string(pr.leaf.size()) + " _LEAF values for " + std::to_string(nv) + " vertices");
        std::vector<uint16_t> q(nv * 2);
        for (size_t v = 0; v < nv; ++v) {
            if (!std::isfinite(pr.leaf[v][0]) || !std::isfinite(pr.leaf[v][1])) throw StagedGlbError(who + " has a non-finite _LEAF value");
            q[v * 2] = unorm16(pr.leaf[v][0]);
            q[v * 2 + 1] = unorm16(pr.leaf[v][1]);
        }
        attrs.i("_LEAF", gb.addAccessor(gb.addView(q.data(), q.size() * 2, 34962), 5123, nv, "VEC2", true));
    }
}

} // namespace detail

/**
 * Writes the nodes as one GLB. Throws StagedGlbError on malformed input (an attribute whose length is not the vertex
 * count, an index out of range, a quantised node with _DISP, or a quantisation error over the limit).
 */
inline std::vector<uint8_t> write(const std::vector<StagedNode>& nodesIn, const WriteOptions& opt, WriteReport* reportOut = nullptr) {
    WriteReport rep;
    rep.quantized = opt.quantize;
    detail::Builder gb;
    std::vector<std::string> meshes, nodes, children;
    // library meshes (instanced by nodes): float positions and normals, written once
    std::unordered_map<std::string, int> libraryMesh;
    std::unordered_map<std::string, size_t> libraryTriangles;
    for (const auto& lm : opt.library) {
        const StagedPrimitive& pr = lm.primitive;
        const size_t nv = pr.positions.size();
        if (pr.mode != 4 || nv == 0 || pr.indices.empty() || pr.indices.size() % 3) throw StagedGlbError("library mesh '" + lm.name + "' is not a non-empty triangle list");
        for (uint32_t i : pr.indices) if (i >= nv) throw StagedGlbError("library mesh '" + lm.name + "': index " + std::to_string(i) + " is past its " + std::to_string(nv) + " vertices");
        if (libraryMesh.count(lm.name)) throw StagedGlbError("library mesh '" + lm.name + "' is given twice");
        const std::vector<Vec3> computed = pr.normals.empty() ? detail::vertexNormals(pr.positions, pr.indices) : std::vector<Vec3>();
        const std::vector<Vec3>& nrm = pr.normals.empty() ? computed : pr.normals;
        if (nrm.size() != nv) throw StagedGlbError("library mesh '" + lm.name + "': " + std::to_string(nrm.size()) + " normals for " + std::to_string(nv) + " vertices");
        std::vector<float> f(nv * 3), g(nv * 3);
        std::vector<double> flo(3, std::numeric_limits<double>::infinity()), fhi(3, -std::numeric_limits<double>::infinity());
        for (size_t v = 0; v < nv; ++v) {
            const float p3[3] = {pr.positions[v].x, pr.positions[v].y, pr.positions[v].z};
            Vec3 u = nrm[v];
            const float l = u.length();
            u = l > 1e-12f ? u / l : Vec3(0, 1, 0);
            for (int a = 0; a < 3; ++a) {
                f[v * 3 + static_cast<size_t>(a)] = p3[a];
                flo[static_cast<size_t>(a)] = std::min(flo[static_cast<size_t>(a)], static_cast<double>(p3[a]));
                fhi[static_cast<size_t>(a)] = std::max(fhi[static_cast<size_t>(a)], static_cast<double>(p3[a]));
            }
            g[v * 3] = u.x; g[v * 3 + 1] = u.y; g[v * 3 + 2] = u.z;
        }
        json::Object attrs;
        attrs.i("POSITION", gb.addAccessor(gb.addView(f.data(), f.size() * 4, 34962), 5126, nv, "VEC3", false, &flo, &fhi));
        attrs.i("NORMAL", gb.addAccessor(gb.addView(g.data(), g.size() * 4, 34962), 5126, nv, "VEC3", false));
        detail::writeTexAttributes(gb, attrs, pr, nv, "library mesh '" + lm.name + "'");
        int indexAccessor;
        if (nv < 65535) {
            std::vector<uint16_t> ix(pr.indices.begin(), pr.indices.end());
            indexAccessor = gb.addAccessor(gb.addView(ix.data(), ix.size() * 2, 34963), 5123, ix.size(), "SCALAR", false);
        } else {
            indexAccessor = gb.addAccessor(gb.addView(pr.indices.data(), pr.indices.size() * 4, 34963), 5125, pr.indices.size(), "SCALAR", false);
        }
        json::Object p;
        p.raw("attributes", attrs.text()).i("indices", indexAccessor).i("material", 0).i("mode", 4);
        json::Object m;
        m.s("name", lm.name).raw("primitives", json::array({p.text()}));
        meshes.push_back(m.text());
        libraryMesh[lm.name] = static_cast<int>(meshes.size()) - 1;
        libraryTriangles[lm.name] = pr.indices.size() / 3;
    }

    // quantisation cubes shared by frame groups: the bounds of every primitive of every node in the group
    std::unordered_map<std::string, std::array<double, 6>> groupBounds;
    std::function<void(const StagedNode&)> collectGroups = [&](const StagedNode& n) {
        if (!n.frameGroup.empty()) {
            auto it = groupBounds.emplace(n.frameGroup, std::array<double, 6>{std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(),
                                                                                -std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()}).first;
            for (const auto& pr : n.primitives) {
                for (const auto& p : pr.positions) {
                    const double v[3] = {p.x, p.y, p.z};
                    for (int a = 0; a < 3; ++a) {
                        it->second[static_cast<size_t>(a)] = std::min(it->second[static_cast<size_t>(a)], v[a]);
                        it->second[static_cast<size_t>(3 + a)] = std::max(it->second[static_cast<size_t>(3 + a)], v[a]);
                    }
                }
            }
        }
        for (const auto& c : n.children) collectGroups(c);
    };
    for (const auto& n : nodesIn) collectGroups(n);
    std::unordered_map<std::string, std::vector<std::string>> writtenPrimitives;  // node name -> its primitives' JSON, for reuse

    // a node's quantisation frame (its children's instances are expressed in it), and what a node that shares its mesh needs
    struct Frame { bool quant{false}; double c[3]{0, 0, 0}; double h{1}; };
    struct Emitted { int mesh{-1}; Frame frame; };
    std::unordered_map<std::string, Emitted> emitted;
    // every instance of the file lives in four shared buffer views (translations, rotations, scales, reveal), each node's
    // accessors pointing into them: the document names four views, not four per instanced node
    std::vector<float> instT, instS;
    std::vector<int16_t> instR;
    std::vector<uint16_t> instV;
    std::function<bool(const StagedNode&)> hasInstances = [&](const StagedNode& n) {
        if (!n.instances.empty()) return true;
        for (const auto& c : n.children) if (hasInstances(c)) return true;
        return false;
    };
    bool anyInstances = false;
    for (const auto& n : nodesIn) anyInstances = anyInstances || hasInstances(n);
    const int viewT = anyInstances ? gb.reserveView() : -1, viewR = anyInstances ? gb.reserveView() : -1, viewS = anyInstances ? gb.reserveView() : -1, viewV = anyInstances ? gb.reserveView() : -1;
    struct InstanceData { std::array<int, 4> acc{-1, -1, -1, -1}; size_t n{0}; };  // TRANSLATION, ROTATION, SCALE, _REVEAL (-1: none)
    std::unordered_map<std::string, InstanceData> instanceAccessors;  // by node name
    bool usesInstancing = false;
    std::function<int(const StagedNode&, const Frame&)> emit = [&](const StagedNode& node, const Frame& parentFrame) -> int {
        const int myIndex = static_cast<int>(nodes.size()) + 1;  // the root node is node 0
        nodes.push_back(std::string());
        // validate, and the node's bounding cube when quantising
        double lo[3] = {std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
        double hi[3] = {-std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()};
        size_t nodeVerts = 0;
        for (const auto& pr : node.primitives) {
            if (pr.mode != 4 && pr.mode != 1) throw StagedGlbError("node '" + node.name + "': primitive mode " + std::to_string(pr.mode) + " is neither TRIANGLES (4) nor LINES (1)");
            const size_t nv = pr.positions.size();
            const size_t per = pr.mode == 4 ? 3 : 2;
            if (pr.indices.size() % per) throw StagedGlbError("node '" + node.name + "': " + std::to_string(pr.indices.size()) + " indices are not whole " + (pr.mode == 4 ? "triangles" : "line segments"));
            for (uint32_t i : pr.indices) if (i >= nv) throw StagedGlbError("node '" + node.name + "': index " + std::to_string(i) + " is past its " + std::to_string(nv) + " vertices");
            if (!pr.normals.empty() && pr.normals.size() != nv) throw StagedGlbError("node '" + node.name + "': " + std::to_string(pr.normals.size()) + " normals for " + std::to_string(nv) + " vertices");
            if (!pr.colors.empty() && pr.colors.size() != nv) throw StagedGlbError("node '" + node.name + "': " + std::to_string(pr.colors.size()) + " colours for " + std::to_string(nv) + " vertices");
            if (!pr.reveal.empty() && pr.reveal.size() != nv) throw StagedGlbError("node '" + node.name + "': " + std::to_string(pr.reveal.size()) + " _REVEAL values for " + std::to_string(nv) + " vertices");
            if (!pr.disp.empty() && pr.disp.size() != nv) throw StagedGlbError("node '" + node.name + "': " + std::to_string(pr.disp.size()) + " _DISP values for " + std::to_string(nv) + " vertices");
            if (!pr.disp.empty() && opt.quantize) throw StagedGlbError("node '" + node.name + "' carries _DISP (metres of the tile frame): it is never quantised");
            for (const auto& p : pr.positions) {
                if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) throw StagedGlbError("node '" + node.name + "' has a non-finite position");
                lo[0] = std::min(lo[0], static_cast<double>(p.x)); hi[0] = std::max(hi[0], static_cast<double>(p.x));
                lo[1] = std::min(lo[1], static_cast<double>(p.y)); hi[1] = std::max(hi[1], static_cast<double>(p.y));
                lo[2] = std::min(lo[2], static_cast<double>(p.z)); hi[2] = std::max(hi[2], static_cast<double>(p.z));
            }
            nodeVerts += nv;
        }
        bool reuses = false;
        for (const auto& pr : node.primitives) reuses = reuses || !pr.reuseNode.empty();
        if (!node.frameGroup.empty()) {
            const auto& gbnd = groupBounds.at(node.frameGroup);
            for (int a = 0; a < 3; ++a) { lo[a] = gbnd[static_cast<size_t>(a)]; hi[a] = gbnd[static_cast<size_t>(3 + a)]; }
        }
        // node transform (quantised): centre and uniform half extent, both float32 as the loader keeps them on the GPU
        double centre[3] = {0, 0, 0}, half = 1.0;
        const bool quantNode = opt.quantize && (nodeVerts > 0 || reuses) && std::isfinite(lo[0]);
        if (quantNode) {
            half = 0;
            for (int a = 0; a < 3; ++a) {
                centre[a] = static_cast<double>(static_cast<float>(0.5 * (lo[a] + hi[a])));
                half = std::max(half, std::max(hi[a] - centre[a], centre[a] - lo[a]));
            }
            // a hair over the extent, so the cube holds every vertex after the centre's rounding
            half = static_cast<double>(static_cast<float>(std::max(1e-6, half * (1.0 + 1e-6))));
        }

        std::vector<std::string> prims;
        for (const auto& pr : node.primitives) {
            if (!pr.reuseNode.empty()) {
                auto it = writtenPrimitives.find(pr.reuseNode);
                if (it == writtenPrimitives.end() || pr.reuseIndex >= it->second.size()) throw StagedGlbError("node '" + node.name + "' reuses primitive " + std::to_string(pr.reuseIndex) + " of '" + pr.reuseNode + "', which was not written before it");
                prims.push_back(it->second[pr.reuseIndex]);
                continue;
            }
            const size_t nv = pr.positions.size();
            if (nv == 0 || pr.indices.empty()) continue;
            json::Object attrs;
            if (quantNode) {
                // POSITION: VEC3 SHORT normalised, padded to 8 bytes a vertex (vertex attributes align to 4)
                std::vector<int16_t> q(nv * 4, 0);
                std::vector<double> qlo(3, 32767.0), qhi(3, -32767.0);
                for (size_t v = 0; v < nv; ++v) {
                    const double p[3] = {pr.positions[v].x, pr.positions[v].y, pr.positions[v].z};
                    double err2 = 0;
                    for (int a = 0; a < 3; ++a) {
                        const int16_t c = detail::snorm16((p[a] - centre[a]) / half);
                        q[v * 4 + static_cast<size_t>(a)] = c;
                        qlo[static_cast<size_t>(a)] = std::min(qlo[static_cast<size_t>(a)], static_cast<double>(c));
                        qhi[static_cast<size_t>(a)] = std::max(qhi[static_cast<size_t>(a)], static_cast<double>(c));
                        const double back = centre[a] + detail::unSnorm16(c) * half;
                        err2 += (back - p[a]) * (back - p[a]);
                    }
                    rep.maxPositionErrorM = std::max(rep.maxPositionErrorM, std::sqrt(err2));
                }
                const int view = gb.addView(q.data(), q.size() * 2, 34962, 8);
                attrs.i("POSITION", gb.addAccessor(view, 5122, nv, "VEC3", true, &qlo, &qhi));
            } else {
                std::vector<float> f(nv * 3);
                std::vector<double> flo(3, std::numeric_limits<double>::infinity()), fhi(3, -std::numeric_limits<double>::infinity());
                for (size_t v = 0; v < nv; ++v) {
                    const float p[3] = {pr.positions[v].x, pr.positions[v].y, pr.positions[v].z};
                    for (int a = 0; a < 3; ++a) {
                        f[v * 3 + static_cast<size_t>(a)] = p[a];
                        flo[static_cast<size_t>(a)] = std::min(flo[static_cast<size_t>(a)], static_cast<double>(p[a]));
                        fhi[static_cast<size_t>(a)] = std::max(fhi[static_cast<size_t>(a)], static_cast<double>(p[a]));
                    }
                }
                const int view = gb.addView(f.data(), f.size() * 4, 34962);
                attrs.i("POSITION", gb.addAccessor(view, 5126, nv, "VEC3", false, &flo, &fhi));
            }
            if (pr.mode == 4) {
                const std::vector<Vec3> computed = pr.normals.empty() ? detail::vertexNormals(pr.positions, pr.indices) : std::vector<Vec3>();
                const std::vector<Vec3>& n = pr.normals.empty() ? computed : pr.normals;
                if (quantNode) {
                    std::vector<int8_t> q(nv * 4, 0);
                    for (size_t v = 0; v < nv; ++v) {
                        Vec3 u = n[v];
                        const float l = u.length();
                        u = l > 1e-12f ? u / l : Vec3(0, 1, 0);
                        const double d[3] = {u.x, u.y, u.z};
                        double back[3], bl = 0;
                        for (int a = 0; a < 3; ++a) {
                            const int8_t c = detail::snorm8(d[a]);
                            q[v * 4 + static_cast<size_t>(a)] = c;
                            back[a] = detail::unSnorm8(c);
                            bl += back[a] * back[a];
                        }
                        bl = std::sqrt(bl);
                        if (bl > 0) {
                            const double cosA = std::clamp((back[0] * d[0] + back[1] * d[1] + back[2] * d[2]) / bl, -1.0, 1.0);
                            rep.maxNormalErrorDeg = std::max(rep.maxNormalErrorDeg, std::acos(cosA) * 180.0 / M_PI);
                        }
                    }
                    const int view = gb.addView(q.data(), q.size(), 34962, 4);
                    attrs.i("NORMAL", gb.addAccessor(view, 5120, nv, "VEC3", true));
                } else {
                    std::vector<float> f(nv * 3);
                    for (size_t v = 0; v < nv; ++v) {
                        Vec3 u = n[v];
                        const float l = u.length();
                        u = l > 1e-12f ? u / l : Vec3(0, 1, 0);
                        f[v * 3] = u.x; f[v * 3 + 1] = u.y; f[v * 3 + 2] = u.z;
                    }
                    const int view = gb.addView(f.data(), f.size() * 4, 34962);
                    attrs.i("NORMAL", gb.addAccessor(view, 5126, nv, "VEC3", false));
                }
            }
            if (!pr.colors.empty()) {
                std::vector<uint8_t> c(nv * 4);
                for (size_t v = 0; v < nv; ++v) for (int k = 0; k < 4; ++k) c[v * 4 + static_cast<size_t>(k)] = pr.colors[v][static_cast<size_t>(k)];
                const int view = gb.addView(c.data(), c.size(), 34962);
                attrs.i("COLOR_0", gb.addAccessor(view, 5121, nv, "VEC4", true));
            }
            if (!pr.reveal.empty()) {
                std::vector<uint16_t> r(nv * 2);
                for (size_t v = 0; v < nv; ++v) {
                    if (!std::isfinite(pr.reveal[v][0]) || !std::isfinite(pr.reveal[v][1])) throw StagedGlbError("node '" + node.name + "' has a non-finite _REVEAL value");
                    r[v * 2] = unorm16(pr.reveal[v][0]);
                    r[v * 2 + 1] = unorm16(pr.reveal[v][1]);
                }
                const int view = gb.addView(r.data(), r.size() * 2, 34962);
                attrs.i("_REVEAL", gb.addAccessor(view, 5123, nv, "VEC2", true));
            }
            detail::writeTexAttributes(gb, attrs, pr, nv, "node '" + node.name + "'");
            if (!pr.disp.empty()) {
                std::vector<float> d(nv * 3);
                for (size_t v = 0; v < nv; ++v) { d[v * 3] = pr.disp[v].x; d[v * 3 + 1] = pr.disp[v].y; d[v * 3 + 2] = pr.disp[v].z; }
                const int view = gb.addView(d.data(), d.size() * 4, 34962);
                attrs.i("_DISP", gb.addAccessor(view, 5126, nv, "VEC3", false));
            }
            int indexAccessor;
            if (nv < 65535) {
                std::vector<uint16_t> ix(pr.indices.begin(), pr.indices.end());
                const int view = gb.addView(ix.data(), ix.size() * 2, 34963);
                indexAccessor = gb.addAccessor(view, 5123, ix.size(), "SCALAR", false);
                ++rep.u16IndexPrimitives;
            } else {
                const int view = gb.addView(pr.indices.data(), pr.indices.size() * 4, 34963);
                indexAccessor = gb.addAccessor(view, 5125, pr.indices.size(), "SCALAR", false);
                ++rep.u32IndexPrimitives;
            }
            json::Object p;
            p.raw("attributes", attrs.text()).i("indices", indexAccessor).i("material", 0).i("mode", pr.mode);
            prims.push_back(p.text());
            rep.vertices += nv;
            if (pr.mode == 4) rep.triangles += pr.indices.size() / 3; else rep.lineSegments += pr.indices.size() / 2;
        }
        writtenPrimitives[node.name] = prims;
        json::Object nd;
        nd.s("name", node.name);
        Frame thisFrame;
        if (!node.meshFrom.empty()) {
            if (!prims.empty()) throw StagedGlbError("node '" + node.name + "' shares the mesh of '" + node.meshFrom + "' and holds primitives of its own");
            auto it = emitted.find(node.meshFrom);
            if (it == emitted.end()) throw StagedGlbError("node '" + node.name + "' shares the mesh of '" + node.meshFrom + "', which was not written before it");
            thisFrame = it->second.frame;
            nd.i("mesh", it->second.mesh);
            if (thisFrame.quant) {
                nd.raw("translation", "[" + json::num(thisFrame.c[0]) + "," + json::num(thisFrame.c[1]) + "," + json::num(thisFrame.c[2]) + "]");
                nd.raw("scale", "[" + json::num(thisFrame.h) + "," + json::num(thisFrame.h) + "," + json::num(thisFrame.h) + "]");
            }
        } else if (!prims.empty()) {
            json::Object m;
            m.s("name", node.name).raw("primitives", json::array(prims));
            meshes.push_back(m.text());
            nd.i("mesh", static_cast<long long>(meshes.size()) - 1);
            thisFrame.quant = quantNode;
            thisFrame.c[0] = centre[0]; thisFrame.c[1] = centre[1]; thisFrame.c[2] = centre[2]; thisFrame.h = half;
            if (quantNode) {
                nd.raw("translation", "[" + json::num(centre[0]) + "," + json::num(centre[1]) + "," + json::num(centre[2]) + "]");
                nd.raw("scale", "[" + json::num(half) + "," + json::num(half) + "," + json::num(half) + "]");
            }
            emitted[node.name] = Emitted{static_cast<int>(meshes.size()) - 1, thisFrame};
        }
        if (!node.extrasJson.empty()) nd.raw("extras", node.extrasJson);
        // instances: EXT_mesh_gpu_instancing, in the parent's frame (a quantised parent's translation and uniform scale undone)
        if (!node.instances.empty()) {
            if (node.instances.size() > 1) throw StagedGlbError("node '" + node.name + "' instances more than one library mesh");
            if (!prims.empty() || !node.meshFrom.empty()) throw StagedGlbError("node '" + node.name + "' instances a library mesh and holds a mesh of its own");
            const StagedInstances& si = node.instances.front();
            auto lib = libraryMesh.find(si.libraryMesh);
            if (lib == libraryMesh.end()) throw StagedGlbError("node '" + node.name + "' instances '" + si.libraryMesh + "', which is not in the library");
            const size_t n = si.translations.size();
            std::array<int, 4> acc{-1, -1, -1, -1};
            size_t count = n;
            if (!si.sameDataAs.empty()) {
                auto it = instanceAccessors.find(si.sameDataAs);
                if (it == instanceAccessors.end()) throw StagedGlbError("node '" + node.name + "' reuses the instances of '" + si.sameDataAs + "', which were not written before it");
                acc = it->second.acc;
                count = it->second.n;
            } else {
                if (n == 0 || si.rotations.size() != n || si.scales.size() != n || (!si.reveal.empty() && si.reveal.size() != n)) {
                    throw StagedGlbError("node '" + node.name + "': instance attributes differ in length (" + std::to_string(n) + " translations, " + std::to_string(si.rotations.size()) + " rotations, " +
                                         std::to_string(si.scales.size()) + " scales)");
                }
                const double inv = parentFrame.quant ? 1.0 / parentFrame.h : 1.0;
                const size_t base = instT.size() / 3;
                instT.resize(instT.size() + n * 3);
                instS.resize(instS.size() + n * 3);
                instR.resize(instR.size() + n * 4);
                for (size_t i = 0; i < n; ++i) {
                    const Vec3& tr = si.translations[i];
                    const double w[3] = {tr.x, tr.y, tr.z};
                    for (int a = 0; a < 3; ++a) instT[(base + i) * 3 + static_cast<size_t>(a)] = static_cast<float>(parentFrame.quant ? (w[a] - parentFrame.c[a]) * inv : w[a]);
                    instS[(base + i) * 3] = static_cast<float>(si.scales[i].x * inv); instS[(base + i) * 3 + 1] = static_cast<float>(si.scales[i].y * inv); instS[(base + i) * 3 + 2] = static_cast<float>(si.scales[i].z * inv);
                    double l2 = 0;
                    for (int a = 0; a < 4; ++a) l2 += static_cast<double>(si.rotations[i][static_cast<size_t>(a)]) * si.rotations[i][static_cast<size_t>(a)];
                    const double il = l2 > 0 ? 1.0 / std::sqrt(l2) : 1.0;
                    for (int a = 0; a < 4; ++a) instR[(base + i) * 4 + static_cast<size_t>(a)] = detail::snorm16(si.rotations[i][static_cast<size_t>(a)] * il);
                    if (!std::isfinite(instT[(base + i) * 3]) || !std::isfinite(instT[(base + i) * 3 + 1]) || !std::isfinite(instT[(base + i) * 3 + 2])) throw StagedGlbError("node '" + node.name + "' has a non-finite instance translation");
                }
                acc[0] = gb.addAccessorAt(viewT, base * 12, 5126, n, "VEC3", false);
                acc[1] = gb.addAccessorAt(viewR, base * 8, 5122, n, "VEC4", true);
                acc[2] = gb.addAccessorAt(viewS, base * 12, 5126, n, "VEC3", false);
                if (!si.reveal.empty()) {
                    // reveal is written for every instance of the file or none (a view is one array): a node without it gets zeros
                    instV.resize(base * 2, 0);
                    for (size_t i = 0; i < n; ++i) {
                        if (!std::isfinite(si.reveal[i][0]) || !std::isfinite(si.reveal[i][1])) throw StagedGlbError("node '" + node.name + "' has a non-finite instance _REVEAL value");
                        instV.push_back(unorm16(si.reveal[i][0]));
                        instV.push_back(unorm16(si.reveal[i][1]));
                    }
                    acc[3] = gb.addAccessorAt(viewV, base * 4, 5123, n, "VEC2", true);
                }
                instanceAccessors[node.name] = InstanceData{acc, n};
                rep.instances += n;
            }
            rep.instancedTriangles += count * libraryTriangles[si.libraryMesh];
            usesInstancing = true;
            nd.i("mesh", lib->second);
            json::Object at;
            at.i("TRANSLATION", acc[0]).i("ROTATION", acc[1]).i("SCALE", acc[2]);
            if (acc[3] >= 0) at.i("_REVEAL", acc[3]);
            json::Object inst;
            inst.raw("attributes", at.text());
            json::Object ext;
            ext.raw("EXT_mesh_gpu_instancing", inst.text());
            nd.raw("extensions", ext.text());
        }
        if (!node.children.empty()) {
            std::vector<std::string> kids;
            for (const auto& c : node.children) kids.push_back(std::to_string(emit(c, thisFrame)));
            nd.raw("children", json::array(kids));
        }
        nodes[static_cast<size_t>(myIndex - 1)] = nd.text();
        return myIndex;
    };
    for (const auto& node : nodesIn) {
        children.push_back(std::to_string(emit(node, Frame{})));
        ++rep.nodes;
    }
    if (usesInstancing) {
        gb.fillView(viewT, instT.data(), instT.size() * 4);
        gb.fillView(viewR, instR.data(), instR.size() * 2);
        gb.fillView(viewS, instS.data(), instS.size() * 4);
        if (instV.empty()) instV.push_back(0);   // no node carries _REVEAL: the view is a placeholder nothing refers to
        gb.fillView(viewV, instV.data(), instV.size() * 2);
    }
    if (opt.quantize && rep.maxPositionErrorM > opt.maxPositionErrorM) {
        throw StagedGlbError("quantised positions are off by up to " + json::num(rep.maxPositionErrorM) + " m, over the " + json::num(opt.maxPositionErrorM) + " m allowed");
    }

    json::Object asset;
    asset.s("version", "2.0").s("generator", opt.generator);
    if (opt.quantize) {
        json::Object q;
        q.s("extension", "KHR_mesh_quantization").i("positionBits", 16).i("normalBits", 8)
            .n("positionMaxErrorM", rep.maxPositionErrorM).n("normalMaxErrorDeg", rep.maxNormalErrorDeg)
            .s("method", "per node: SHORT normalised positions over the node's bounding cube (translation = centre, uniform scale = half extent), BYTE normalised normals; error measured on the written values");
        asset.raw("extras", "{\"scratchbox\":{\"quantization\":" + q.text() + "}}");
    }
    std::string j = "{\"asset\":" + asset.text() + ",";
    if (opt.quantize || usesInstancing) {
        std::vector<std::string> used;
        if (opt.quantize) used.push_back("\"KHR_mesh_quantization\"");
        if (usesInstancing) used.push_back("\"EXT_mesh_gpu_instancing\"");
        j += "\"extensionsUsed\":" + json::array(used) + ",";
        if (opt.quantize) j += "\"extensionsRequired\":[\"KHR_mesh_quantization\"],";
    }
    j += "\"scene\":0,\"scenes\":[{\"nodes\":[0]" + (opt.rootExtrasJson.empty() ? std::string() : ",\"extras\":" + opt.rootExtrasJson) + "}],\"nodes\":[";
    {
        json::Object root;
        root.s("name", opt.rootName);
        if (!children.empty()) root.raw("children", json::array(children));
        j += root.text();
    }
    for (const auto& n : nodes) j += "," + n;
    j += "]";
    if (!meshes.empty()) j += ",\"meshes\":" + json::array(meshes);
    {
        json::Object pbr;
        pbr.raw("baseColorFactor", "[" + json::num(opt.clayColor[0]) + "," + json::num(opt.clayColor[1]) + "," + json::num(opt.clayColor[2]) + "," + json::num(opt.clayColor[3]) + "]")
            .n("metallicFactor", 0).n("roughnessFactor", opt.clayRoughness);
        json::Object mat;
        mat.s("name", "Mat_StudioGreyClay").raw("pbrMetallicRoughness", pbr.text()).b("doubleSided", false);
        j += ",\"materials\":[" + mat.text() + "]";
    }
    if (!gb.accessors.empty()) {
        j += ",\"accessors\":" + json::array(gb.accessors) + ",\"bufferViews\":" + json::array(gb.views);
        j += ",\"buffers\":[{\"byteLength\":" + std::to_string((gb.bin.size() + 3) & ~static_cast<size_t>(3)) + "}]";
    }
    if (!opt.rootExtrasJson.empty()) j += ",\"extras\":" + opt.rootExtrasJson;
    j += "}";
    rep.jsonBytes = j.size();
    rep.binBytes = gb.bin.size();
    std::vector<uint8_t> out = gb.finish(j);
    rep.bytes = out.size();
    if (reportOut) *reportOut = rep;
    return out;
}

} // namespace staged_glb
} // namespace scratchbox

#endif // SCRATCHBOX_STAGED_GLB_HPP
