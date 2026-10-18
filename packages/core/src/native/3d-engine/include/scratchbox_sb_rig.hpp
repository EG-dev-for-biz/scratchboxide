/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Rig: analytical auto-rigger for arbitrary meshes.
 *
 * Discovers a joint tree and 4-bone skin weights purely from geometry (no digit/limb taxonomy,
 * no world-unit constants): seam-welded edge graph -> average geodesic distance (AGD) field ->
 * band Reeb graph -> medial node positions -> loop cutting / pruning / hub merging -> joint
 * placement -> region-seeded geodesic weights.
 *
 * GLB vertex order contract (shared by `readSceneGeometry` and `SbRigGlbPatcher`): scene roots
 * depth-first, mesh before children, primitives in order, triangle primitives only. This is the
 * same order `gltf::GlbSceneReader` and `glb-geometry-patcher.ts` use.
 */

#ifndef SCRATCHBOX_SB_RIG_HPP
#define SCRATCHBOX_SB_RIG_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_skinning.hpp"
#include "scratchbox_bvh.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <numeric>
#include <queue>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace scratchbox {
namespace sb_rig {

using geometry::ScratchboxMesh;
using math::Mat4;
using math::Ray;
using math::Vec3;

constexpr float kInf = std::numeric_limits<float>::infinity();

// ============================================================================
// 1. PARAMETERS & RESULT
// ============================================================================

/** Every length is a dimensionless fraction of a length the mesh measures itself. */
struct SbRigParams {
    float weldFrac{1e-5f};            // of bbox diagonal
    float refineEdgeMultiple{2.0f};   // analysis graph splits edges longer than this x median (0 = off)
    int agdSamples{48};
    float bandFrac{0.015f};           // of normalised AGD range (a floor; see bandEdgeMultiple)
    float bandEdgeMultiple{3.0f};     // bands span at least this many median edge lengths
    float loopContractRatio{3.0f};    // loops shorter than this x median ring radius are artifacts
    float minNodeFrac{0.0005f};       // of main-component vertex count
    float minBranchFrac{0.04f};       // of geodesic diameter D
    float hubMergeFrac{0.05f};        // of D
    float jointDeviationFrac{0.02f};  // of D
    float radiusWeight{0.5f};
    float bendThresholdRad{0.35f};
    float minBoneFrac{0.025f};        // of D
    float maxBoneFrac{0.25f};         // of D
    int minLeafChainSegments{3};
    float blendScale{0.6f};           // of local ring radius
    bool emitTipJoints{true};
    bool hasRootHint{false};
    Vec3 rootHint{0.0f, 0.0f, 0.0f};
    std::vector<std::vector<Vec3>> chainHints;  // each ordered base -> tip

    void validate() const {
        auto positive = [](float v, const char* name) {
            if (!(std::isfinite(v) && v > 0.0f)) throw std::invalid_argument(std::string(name) + " must be a positive finite number");
        };
        positive(weldFrac, "weldFrac");
        positive(bandFrac, "bandFrac");
        positive(bandEdgeMultiple, "bandEdgeMultiple");
        positive(loopContractRatio, "loopContractRatio");
        positive(minNodeFrac, "minNodeFrac");
        positive(minBranchFrac, "minBranchFrac");
        positive(hubMergeFrac, "hubMergeFrac");
        positive(jointDeviationFrac, "jointDeviationFrac");
        positive(bendThresholdRad, "bendThresholdRad");
        positive(minBoneFrac, "minBoneFrac");
        positive(maxBoneFrac, "maxBoneFrac");
        positive(blendScale, "blendScale");
        if (!(std::isfinite(radiusWeight) && radiusWeight >= 0.0f)) throw std::invalid_argument("radiusWeight must be >= 0");
        if (!(std::isfinite(refineEdgeMultiple) && (refineEdgeMultiple == 0.0f || refineEdgeMultiple >= 1.0f))) {
            throw std::invalid_argument("refineEdgeMultiple must be 0 (off) or >= 1");
        }
        if (bandFrac > 0.5f) throw std::invalid_argument("bandFrac must be <= 0.5");
        if (maxBoneFrac < minBoneFrac) throw std::invalid_argument("maxBoneFrac must be >= minBoneFrac");
        if (agdSamples < 2) throw std::invalid_argument("agdSamples must be >= 2");
        if (minLeafChainSegments < 1) throw std::invalid_argument("minLeafChainSegments must be >= 1");
        for (const auto& hint : chainHints) {
            if (hint.size() < 2) throw std::invalid_argument("each chain hint needs at least 2 points (base ... tip)");
        }
    }

    /** Sets a numeric/boolean field by its camelCase name (used by the CLI runner). */
    void set(const std::string& name, const std::string& value) {
        char* end = nullptr;
        double v = std::strtod(value.c_str(), &end);
        bool numeric = end && *end == '\0' && !value.empty();
        auto num = [&]() -> double {
            if (!numeric) throw std::invalid_argument("parameter " + name + " expects a number, got '" + value + "'");
            return v;
        };
        if (name == "weldFrac") weldFrac = static_cast<float>(num());
        else if (name == "refineEdgeMultiple") refineEdgeMultiple = static_cast<float>(num());
        else if (name == "agdSamples") agdSamples = static_cast<int>(num());
        else if (name == "bandFrac") bandFrac = static_cast<float>(num());
        else if (name == "bandEdgeMultiple") bandEdgeMultiple = static_cast<float>(num());
        else if (name == "loopContractRatio") loopContractRatio = static_cast<float>(num());
        else if (name == "minNodeFrac") minNodeFrac = static_cast<float>(num());
        else if (name == "minBranchFrac") minBranchFrac = static_cast<float>(num());
        else if (name == "hubMergeFrac") hubMergeFrac = static_cast<float>(num());
        else if (name == "jointDeviationFrac") jointDeviationFrac = static_cast<float>(num());
        else if (name == "radiusWeight") radiusWeight = static_cast<float>(num());
        else if (name == "bendThresholdRad") bendThresholdRad = static_cast<float>(num());
        else if (name == "minBoneFrac") minBoneFrac = static_cast<float>(num());
        else if (name == "maxBoneFrac") maxBoneFrac = static_cast<float>(num());
        else if (name == "minLeafChainSegments") minLeafChainSegments = static_cast<int>(num());
        else if (name == "blendScale") blendScale = static_cast<float>(num());
        else if (name == "emitTipJoints") emitTipJoints = (value == "true" || value == "1");
        else throw std::invalid_argument("unknown SB-Rig parameter '" + name + "'");
    }
};

using RenameMap = std::vector<std::pair<std::string, std::string>>;

struct SbRigChain {
    std::string name;
    int32_t parentJoint{-1};
    std::vector<int32_t> joints;
    bool leaf{false};
    bool hinted{false};
    float length{0.0f};
};

struct SbRigReport {
    size_t inputVertices{0};
    size_t inputTriangles{0};
    size_t weldedVertices{0};
    size_t analysisVertices{0};
    size_t components{0};
    size_t mainComponentVertices{0};
    size_t boundaryEdges{0};
    size_t nonManifoldEdges{0};
    float bboxDiagonal{0.0f};
    float geodesicDiameter{0.0f};
    int agdSamples{0};
    int bands{0};
    size_t reebNodes{0};
    size_t loopsCut{0};
    size_t loopsContracted{0};
    size_t leavesPruned{0};
    size_t hubsMerged{0};
    float medialHitRatio{0.0f};
    size_t secondaryVerticesBound{0};
    std::string rootSource;
    std::vector<std::pair<std::string, double>> timingsMs;
    std::vector<std::string> warnings;

    struct TreeNode {
        int32_t id{-1};
        int32_t parent{-1};
        float level{0.0f};
        float radius{0.0f};
        Vec3 position{0.0f, 0.0f, 0.0f};
        size_t vertices{0};
        int32_t ownerJoint{-1};
    };
    std::vector<TreeNode> tree;  // the final skeleton tree over Reeb nodes (diagnostics)
};

inline void validateJointName(const std::string& name) {
    if (name.empty()) throw std::invalid_argument("joint names must be non-empty");
    for (unsigned char c : name) {
        if (c < 0x20 || c == '"' || c == '\\') {
            throw std::invalid_argument("joint name '" + name + "' contains a quote, backslash or control character");
        }
    }
}

struct SbRigResult {
    kinematics::Skeleton skeleton;
    std::vector<uint8_t> jointIsTip;
    std::vector<SbRigChain> chains;
    std::vector<skinning::VertexSkinWeight> weights;  // one per input vertex
    std::vector<int32_t> vertexOwner;                 // one per input vertex: hard segmentation joint
    SbRigReport report;

    size_t leafCount() const {
        size_t n = 0;
        for (const auto& c : chains) n += c.leaf ? 1 : 0;
        return n;
    }

    /**
     * Keys refer to current names. A chain name renames its joints to <value>1..n; any other key
     * must be an exact joint name. Applied in order.
     */
    void rename(const RenameMap& map) {
        std::vector<std::string> names;
        names.reserve(skeleton.joints.size());
        for (const auto& j : skeleton.joints) names.push_back(j.name);
        for (const auto& [from, to] : map) {
            validateJointName(to);
            auto chainIt = std::find_if(chains.begin(), chains.end(), [&](const SbRigChain& c) { return c.name == from; });
            if (chainIt != chains.end()) {
                for (size_t i = 0; i < chainIt->joints.size(); ++i) names[chainIt->joints[i]] = to + std::to_string(i + 1);
                chainIt->name = to;
                continue;
            }
            auto nameIt = std::find(names.begin(), names.end(), from);
            if (nameIt == names.end()) throw std::invalid_argument("rename key '" + from + "' matches no chain or joint");
            *nameIt = to;
        }
        std::unordered_set<std::string> seen;
        for (const auto& n : names) {
            if (!seen.insert(n).second) throw std::invalid_argument("rename produces duplicate joint name '" + n + "'");
        }
        for (size_t i = 0; i < names.size(); ++i) skeleton.joints[i].name = names[i];
    }
};

// ============================================================================
// 2. LOSSLESS JSON (untouched values keep their exact source text)
// ============================================================================

struct RawJson {
    enum Kind : uint8_t { Null, Bool, Number, String, Array, Object };
    Kind kind{Null};
    std::string raw;  // scalars: exact token text (strings include their quotes)
    std::vector<RawJson> arr;
    std::vector<std::pair<std::string, RawJson>> obj;  // keys keep their escaped source text

    static RawJson array() { RawJson j; j.kind = Array; return j; }
    static RawJson object() { RawJson j; j.kind = Object; return j; }
    static RawJson boolean(bool b) { RawJson j; j.kind = Bool; j.raw = b ? "true" : "false"; return j; }
    static RawJson string(std::string_view s) { RawJson j; j.kind = String; j.raw = quote(s); return j; }
    static RawJson number(double v) {
        if (!std::isfinite(v)) throw std::runtime_error("SB-Rig produced a non-finite number");
        RawJson j;
        j.kind = Number;
        char buf[48];
        if (std::nearbyint(v) == v && std::fabs(v) < 9.0e15) std::snprintf(buf, sizeof(buf), "%.0f", v);
        else std::snprintf(buf, sizeof(buf), "%.9g", v);
        j.raw = buf;
        return j;
    }
    static RawJson vec3(const Vec3& v) {
        RawJson a = array();
        a.arr = {number(v.x), number(v.y), number(v.z)};
        return a;
    }

    const RawJson* get(std::string_view key) const {
        if (kind != Object) return nullptr;
        for (const auto& kv : obj) if (kv.first == key) return &kv.second;
        return nullptr;
    }
    RawJson* get(std::string_view key) {
        if (kind != Object) return nullptr;
        for (auto& kv : obj) if (kv.first == key) return &kv.second;
        return nullptr;
    }
    RawJson& set(std::string_view key, RawJson v) {
        if (kind != Object) throw std::logic_error("RawJson::set on a non-object");
        if (RawJson* existing = get(key)) {
            *existing = std::move(v);
            return *existing;
        }
        obj.emplace_back(std::string(key), std::move(v));
        return obj.back().second;
    }
    void erase(std::string_view key) {
        obj.erase(std::remove_if(obj.begin(), obj.end(), [&](const auto& kv) { return kv.first == key; }), obj.end());
    }
    RawJson& push(RawJson v) {
        if (kind != Array) throw std::logic_error("RawJson::push on a non-array");
        arr.push_back(std::move(v));
        return arr.back();
    }

    double asNumber(double def = 0.0) const { return kind == Number ? std::strtod(raw.c_str(), nullptr) : def; }
    int64_t asInt(int64_t def = -1) const { return kind == Number ? static_cast<int64_t>(std::llround(asNumber())) : def; }
    bool asBool(bool def = false) const { return kind == Bool ? raw == "true" : def; }
    std::string asString(const std::string& def = "") const { return kind == String ? unescape(raw) : def; }

    void dump(std::string& out) const {
        switch (kind) {
            case Null: out += "null"; break;
            case Bool:
            case Number:
            case String: out += raw; break;
            case Array:
                out += '[';
                for (size_t i = 0; i < arr.size(); ++i) {
                    if (i) out += ',';
                    arr[i].dump(out);
                }
                out += ']';
                break;
            case Object:
                out += '{';
                for (size_t i = 0; i < obj.size(); ++i) {
                    if (i) out += ',';
                    out += '"';
                    out += obj[i].first;
                    out += "\":";
                    obj[i].second.dump(out);
                }
                out += '}';
                break;
        }
    }
    std::string dump() const {
        std::string s;
        dump(s);
        return s;
    }

    static std::string quote(std::string_view s) {
        std::string out = "\"";
        for (unsigned char c : s) {
            switch (c) {
                case '"': out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (c < 0x20) {
                        char buf[8];
                        std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                        out += buf;
                    } else {
                        out += static_cast<char>(c);
                    }
            }
        }
        out += '"';
        return out;
    }

    static void appendUtf8(std::string& out, uint32_t cp) {
        if (cp < 0x80) out += static_cast<char>(cp);
        else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    static std::string unescape(const std::string& quoted) {
        std::string out;
        size_t end = quoted.size() >= 2 ? quoted.size() - 1 : quoted.size();
        for (size_t i = 1; i < end; ++i) {
            char c = quoted[i];
            if (c != '\\' || i + 1 >= end) {
                out += c;
                continue;
            }
            char e = quoted[++i];
            switch (e) {
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    auto hex = [&](size_t at) -> uint32_t {
                        if (at + 4 > end) return 0xFFFD;
                        return static_cast<uint32_t>(std::strtoul(quoted.substr(at, 4).c_str(), nullptr, 16));
                    };
                    uint32_t cp = hex(i + 1);
                    i += 4;
                    if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 < end + 1 && quoted[i + 1] == '\\' && quoted[i + 2] == 'u') {
                        uint32_t lo = hex(i + 3);
                        if (lo >= 0xDC00 && lo <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            i += 6;
                        }
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: out += e;
            }
        }
        return out;
    }
};

class RawJsonParser {
public:
    RawJsonParser(const char* data, size_t length) : p_(data), end_(data + length) {}

    RawJson parse() {
        RawJson v = value(0);
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r' || *p_ == '\0')) ++p_;
        if (p_ != end_) fail("trailing characters after the JSON document");
        return v;
    }

private:
    const char* p_;
    const char* end_;

    [[noreturn]] void fail(const char* what) { throw std::runtime_error(std::string("glTF JSON parse error: ") + what); }

    void ws() {
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) ++p_;
    }

    RawJson value(int depth) {
        if (depth > 256) fail("nesting too deep");
        ws();
        if (p_ >= end_) fail("unexpected end of input");
        char c = *p_;
        if (c == '{') return objectValue(depth);
        if (c == '[') return arrayValue(depth);
        if (c == '"') {
            RawJson j;
            j.kind = RawJson::String;
            j.raw = stringToken();
            return j;
        }
        if (c == '-' || (c >= '0' && c <= '9')) return numberValue();
        return literal();
    }

    std::string stringToken() {
        const char* start = p_++;
        while (p_ < end_ && *p_ != '"') {
            if (*p_ == '\\') ++p_;
            ++p_;
        }
        if (p_ >= end_) fail("unterminated string");
        ++p_;
        return std::string(start, p_);
    }

    RawJson objectValue(int depth) {
        RawJson j = RawJson::object();
        ++p_;
        ws();
        if (p_ < end_ && *p_ == '}') {
            ++p_;
            return j;
        }
        while (true) {
            ws();
            if (p_ >= end_ || *p_ != '"') fail("expected an object key");
            std::string key = stringToken();
            key = key.substr(1, key.size() - 2);
            ws();
            if (p_ >= end_ || *p_ != ':') fail("expected ':'");
            ++p_;
            j.obj.emplace_back(std::move(key), value(depth + 1));
            ws();
            if (p_ >= end_) fail("unterminated object");
            if (*p_ == ',') { ++p_; continue; }
            if (*p_ == '}') { ++p_; return j; }
            fail("expected ',' or '}'");
        }
    }

    RawJson arrayValue(int depth) {
        RawJson j = RawJson::array();
        ++p_;
        ws();
        if (p_ < end_ && *p_ == ']') {
            ++p_;
            return j;
        }
        while (true) {
            j.arr.push_back(value(depth + 1));
            ws();
            if (p_ >= end_) fail("unterminated array");
            if (*p_ == ',') { ++p_; continue; }
            if (*p_ == ']') { ++p_; return j; }
            fail("expected ',' or ']'");
        }
    }

    RawJson numberValue() {
        const char* start = p_;
        if (*p_ == '-') ++p_;
        while (p_ < end_ && ((*p_ >= '0' && *p_ <= '9') || *p_ == '.' || *p_ == 'e' || *p_ == 'E' || *p_ == '+' || *p_ == '-')) ++p_;
        RawJson j;
        j.kind = RawJson::Number;
        j.raw.assign(start, p_);
        if (j.raw == "-") fail("malformed number");
        return j;
    }

    RawJson literal() {
        auto match = [&](const char* word) {
            size_t n = std::strlen(word);
            if (static_cast<size_t>(end_ - p_) >= n && std::strncmp(p_, word, n) == 0) {
                p_ += n;
                return true;
            }
            return false;
        };
        if (match("true")) return RawJson::boolean(true);
        if (match("false")) return RawJson::boolean(false);
        if (match("null")) return RawJson{};
        fail("unexpected character");
    }
};

// ============================================================================
// 3. GLB CONTAINER & SCENE GEOMETRY
// ============================================================================

struct GlbContainer {
    RawJson json;
    std::vector<uint8_t> bin;

    static GlbContainer parse(const std::vector<uint8_t>& data) {
        if (data.size() < 20) throw std::invalid_argument("file is too small to be a GLB");
        auto u32 = [&](size_t off) {
            uint32_t v;
            std::memcpy(&v, data.data() + off, 4);
            return v;
        };
        if (u32(0) != 0x46546C67u) throw std::invalid_argument("not a GLB file (bad magic)");
        if (u32(4) != 2) throw std::invalid_argument("unsupported GLB version " + std::to_string(u32(4)));
        size_t total = std::min<size_t>(u32(8), data.size());
        size_t off = 12;
        bool haveJson = false;
        GlbContainer c;
        while (off + 8 <= total) {
            uint32_t len = u32(off);
            uint32_t type = u32(off + 4);
            size_t start = off + 8;
            if (start + len > total) throw std::invalid_argument("GLB chunk extends past the end of the file");
            if (type == 0x4E4F534Au && !haveJson) {
                c.json = RawJsonParser(reinterpret_cast<const char*>(data.data() + start), len).parse();
                haveJson = true;
            } else if (type == 0x004E4942u && c.bin.empty()) {
                c.bin.assign(data.begin() + static_cast<std::ptrdiff_t>(start), data.begin() + static_cast<std::ptrdiff_t>(start + len));
            }
            off = start + len;
        }
        if (!haveJson || c.json.kind != RawJson::Object) throw std::invalid_argument("GLB has no JSON chunk");
        return c;
    }

    std::vector<uint8_t> serialize() const {
        std::string jsonText = json.dump();
        while (jsonText.size() % 4) jsonText += ' ';
        size_t binLen = bin.size();
        size_t binPad = (4 - binLen % 4) % 4;
        bool hasBin = binLen > 0;
        size_t total = 12 + 8 + jsonText.size() + (hasBin ? 8 + binLen + binPad : 0);
        std::vector<uint8_t> out(total, 0);
        auto put = [&](size_t off, uint32_t v) { std::memcpy(out.data() + off, &v, 4); };
        put(0, 0x46546C67u);
        put(4, 2);
        put(8, static_cast<uint32_t>(total));
        put(12, static_cast<uint32_t>(jsonText.size()));
        put(16, 0x4E4F534Au);
        std::memcpy(out.data() + 20, jsonText.data(), jsonText.size());
        if (hasBin) {
            size_t off = 20 + jsonText.size();
            put(off, static_cast<uint32_t>(binLen + binPad));
            put(off + 4, 0x004E4942u);
            std::memcpy(out.data() + off + 8, bin.data(), binLen);
        }
        return out;
    }

    static std::vector<uint8_t> readFile(const std::string& path) {
        std::ifstream f(path, std::ios::binary | std::ios::ate);
        if (!f.is_open()) throw std::invalid_argument("cannot open " + path);
        std::streamsize size = f.tellg();
        f.seekg(0, std::ios::beg);
        std::vector<uint8_t> data(static_cast<size_t>(std::max<std::streamsize>(size, 0)));
        if (size <= 0 || !f.read(reinterpret_cast<char*>(data.data()), size)) throw std::invalid_argument("cannot read " + path);
        return data;
    }

    static void writeFile(const std::string& path, const std::vector<uint8_t>& data) {
        std::ofstream f(path, std::ios::binary);
        if (!f.is_open()) throw std::runtime_error("cannot write " + path);
        f.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
        if (!f) throw std::runtime_error("failed while writing " + path);
    }
};

namespace detail {

struct AccessorView {
    const uint8_t* base{nullptr};
    size_t count{0};
    int components{0};
    int componentType{0};
    bool normalized{false};
    size_t stride{0};
};

inline int typeComponents(const std::string& t) {
    if (t == "SCALAR") return 1;
    if (t == "VEC2") return 2;
    if (t == "VEC3") return 3;
    if (t == "VEC4") return 4;
    if (t == "MAT4") return 16;
    return 0;
}

inline size_t componentBytes(int componentType) {
    switch (componentType) {
        case 5120: case 5121: return 1;
        case 5122: case 5123: return 2;
        case 5125: case 5126: return 4;
        default: return 0;
    }
}

inline const RawJson& requireArray(const RawJson& root, const char* key) {
    const RawJson* v = root.get(key);
    if (!v || v->kind != RawJson::Array) throw std::invalid_argument(std::string("glTF has no '") + key + "' array");
    return *v;
}

inline AccessorView viewAccessor(const GlbContainer& g, int64_t index) {
    const RawJson& accessors = requireArray(g.json, "accessors");
    const std::string label = "accessor " + std::to_string(index);
    if (index < 0 || index >= static_cast<int64_t>(accessors.arr.size())) throw std::invalid_argument(label + " is out of range");
    const RawJson& acc = accessors.arr[static_cast<size_t>(index)];
    if (acc.get("sparse")) throw std::invalid_argument(label + " is sparse; sparse accessors are not supported");
    const RawJson* bv = acc.get("bufferView");
    if (!bv) throw std::invalid_argument(label + " has no bufferView (Draco/meshopt-compressed geometry is not supported; re-export uncompressed)");
    const RawJson& views = requireArray(g.json, "bufferViews");
    int64_t viewIndex = bv->asInt();
    if (viewIndex < 0 || viewIndex >= static_cast<int64_t>(views.arr.size())) throw std::invalid_argument(label + " references a missing bufferView");
    const RawJson& view = views.arr[static_cast<size_t>(viewIndex)];
    const RawJson* buf = view.get("buffer");
    if (!buf || buf->asInt() != 0) throw std::invalid_argument(label + " is not in the GLB-embedded buffer 0");

    AccessorView a;
    const RawJson* ct = acc.get("componentType");
    const RawJson* ty = acc.get("type");
    const RawJson* cnt = acc.get("count");
    a.componentType = ct ? static_cast<int>(ct->asInt(0)) : 0;
    a.components = ty ? typeComponents(ty->asString()) : 0;
    a.normalized = acc.get("normalized") && acc.get("normalized")->asBool();
    a.count = cnt ? static_cast<size_t>(std::max<int64_t>(cnt->asInt(0), 0)) : 0;
    size_t elementSize = componentBytes(a.componentType) * static_cast<size_t>(a.components);
    const RawJson* stride = view.get("byteStride");
    a.stride = stride ? static_cast<size_t>(stride->asInt(0)) : 0;
    if (a.stride == 0) a.stride = elementSize;
    size_t offset = static_cast<size_t>((view.get("byteOffset") ? view.get("byteOffset")->asInt(0) : 0) +
                                        (acc.get("byteOffset") ? acc.get("byteOffset")->asInt(0) : 0));
    if (elementSize == 0 || a.count == 0) throw std::invalid_argument(label + " is empty or has an unknown type");
    if (offset + (a.count - 1) * a.stride + elementSize > g.bin.size()) throw std::invalid_argument(label + " reads past the end of the BIN chunk");
    a.base = g.bin.data() + offset;
    return a;
}

inline float readComponent(const AccessorView& a, size_t element, int c) {
    const uint8_t* p = a.base + element * a.stride + static_cast<size_t>(c) * componentBytes(a.componentType);
    switch (a.componentType) {
        case 5126: { float f; std::memcpy(&f, p, 4); return f; }
        case 5121: return a.normalized ? p[0] / 255.0f : static_cast<float>(p[0]);
        case 5120: {
            auto v = static_cast<int8_t>(p[0]);
            return a.normalized ? std::max(v / 127.0f, -1.0f) : static_cast<float>(v);
        }
        case 5123: { uint16_t v; std::memcpy(&v, p, 2); return a.normalized ? v / 65535.0f : static_cast<float>(v); }
        case 5122: {
            int16_t v;
            std::memcpy(&v, p, 2);
            return a.normalized ? std::max(v / 32767.0f, -1.0f) : static_cast<float>(v);
        }
        case 5125: { uint32_t v; std::memcpy(&v, p, 4); return static_cast<float>(v); }
        default: return 0.0f;
    }
}

inline uint32_t readIndex(const AccessorView& a, size_t element) {
    const uint8_t* p = a.base + element * a.stride;
    switch (a.componentType) {
        case 5121: return p[0];
        case 5123: { uint16_t v; std::memcpy(&v, p, 2); return v; }
        case 5125: { uint32_t v; std::memcpy(&v, p, 4); return v; }
        default: throw std::invalid_argument("index accessor has a non-integer component type");
    }
}

inline Mat4 nodeLocalMatrix(const RawJson& node) {
    const RawJson* matrix = node.get("matrix");
    if (matrix && matrix->arr.size() == 16) {
        Mat4 m;
        for (size_t i = 0; i < 16; ++i) m.m[i] = static_cast<float>(matrix->arr[i].asNumber(0.0));
        return m;
    }
    Vec3 t(0, 0, 0), s(1, 1, 1);
    float qx = 0, qy = 0, qz = 0, qw = 1;
    if (const RawJson* tr = node.get("translation"); tr && tr->arr.size() == 3) {
        t = Vec3(static_cast<float>(tr->arr[0].asNumber()), static_cast<float>(tr->arr[1].asNumber()), static_cast<float>(tr->arr[2].asNumber()));
    }
    if (const RawJson* sc = node.get("scale"); sc && sc->arr.size() == 3) {
        s = Vec3(static_cast<float>(sc->arr[0].asNumber(1)), static_cast<float>(sc->arr[1].asNumber(1)), static_cast<float>(sc->arr[2].asNumber(1)));
    }
    if (const RawJson* rot = node.get("rotation"); rot && rot->arr.size() == 4) {
        qx = static_cast<float>(rot->arr[0].asNumber());
        qy = static_cast<float>(rot->arr[1].asNumber());
        qz = static_cast<float>(rot->arr[2].asNumber());
        qw = static_cast<float>(rot->arr[3].asNumber(1));
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

inline bool isIdentity(const Mat4& m, float tol = 1e-6f) {
    for (int i = 0; i < 16; ++i) {
        float expected = (i % 5 == 0) ? 1.0f : 0.0f;
        if (std::fabs(m.m[i] - expected) > tol) return false;
    }
    return true;
}

inline std::vector<int64_t> sceneRoots(const RawJson& json) {
    std::vector<int64_t> roots;
    const RawJson* nodes = json.get("nodes");
    size_t nodeCount = nodes ? nodes->arr.size() : 0;
    int64_t sceneIndex = json.get("scene") ? json.get("scene")->asInt(0) : 0;
    const RawJson* scenes = json.get("scenes");
    if (scenes && !scenes->arr.empty() && sceneIndex >= 0 && sceneIndex < static_cast<int64_t>(scenes->arr.size())) {
        if (const RawJson* sn = scenes->arr[static_cast<size_t>(sceneIndex)].get("nodes")) {
            for (const auto& n : sn->arr) roots.push_back(n.asInt());
        }
    } else {
        std::vector<bool> isChild(nodeCount, false);
        for (size_t i = 0; i < nodeCount; ++i) {
            if (const RawJson* ch = nodes->arr[i].get("children")) {
                for (const auto& c : ch->arr) {
                    int64_t ci = c.asInt();
                    if (ci >= 0 && ci < static_cast<int64_t>(nodeCount)) isChild[static_cast<size_t>(ci)] = true;
                }
            }
        }
        for (size_t i = 0; i < nodeCount; ++i) if (!isChild[i]) roots.push_back(static_cast<int64_t>(i));
    }
    return roots;
}

}  // namespace detail

struct PrimitiveInstance {
    int64_t node{-1};
    int64_t mesh{-1};
    int64_t primitive{-1};
    Mat4 world{Mat4::identity()};
    uint32_t vertexBase{0};
    uint32_t vertexCount{0};
};

struct SceneGeometry {
    ScratchboxMesh mesh;  // world-space positions merged in contract order
    std::vector<PrimitiveInstance> instances;
};

inline SceneGeometry readSceneGeometry(const GlbContainer& g) {
    SceneGeometry scene;
    const RawJson* nodes = g.json.get("nodes");
    const RawJson* meshes = g.json.get("meshes");
    if (!nodes || !meshes) throw std::invalid_argument("glTF has no nodes or meshes");
    std::unordered_map<int64_t, int> meshUses;

    struct Frame { int64_t node; Mat4 parent; int depth; };
    std::vector<Frame> stack;
    std::vector<int64_t> roots = detail::sceneRoots(g.json);
    for (auto it = roots.rbegin(); it != roots.rend(); ++it) stack.push_back({*it, Mat4::identity(), 0});

    while (!stack.empty()) {
        Frame f = stack.back();
        stack.pop_back();
        if (f.node < 0 || f.node >= static_cast<int64_t>(nodes->arr.size()) || f.depth > 64) continue;
        const RawJson& node = nodes->arr[static_cast<size_t>(f.node)];
        Mat4 world = f.parent * detail::nodeLocalMatrix(node);
        const RawJson* meshRef = node.get("mesh");
        int64_t meshIndex = meshRef ? meshRef->asInt() : -1;
        if (meshIndex >= 0 && meshIndex < static_cast<int64_t>(meshes->arr.size())) {
            const RawJson* prims = meshes->arr[static_cast<size_t>(meshIndex)].get("primitives");
            bool hasTriangles = false, hasOther = false;
            if (prims) {
                for (const auto& prim : prims->arr) {
                    int64_t mode = prim.get("mode") ? prim.get("mode")->asInt(4) : 4;
                    (mode == 4 ? hasTriangles : hasOther) = true;
                }
            }
            if (hasTriangles && hasOther) {
                throw std::invalid_argument("mesh " + std::to_string(meshIndex) + " mixes triangle and non-triangle primitives; SB-Rig v1 rigs triangle meshes only");
            }
            if (hasTriangles) {
                if (++meshUses[meshIndex] > 1) {
                    throw std::invalid_argument("mesh " + std::to_string(meshIndex) + " is instanced by more than one node; SB-Rig v1 rigs single-instance meshes only");
                }
                for (size_t p = 0; p < prims->arr.size(); ++p) {
                    const RawJson& prim = prims->arr[p];
                    const RawJson* attrs = prim.get("attributes");
                    const RawJson* posRef = attrs ? attrs->get("POSITION") : nullptr;
                    if (!posRef) throw std::invalid_argument("mesh " + std::to_string(meshIndex) + " primitive " + std::to_string(p) + " has no POSITION");
                    detail::AccessorView pos = detail::viewAccessor(g, posRef->asInt());
                    if (pos.components != 3) throw std::invalid_argument("POSITION accessor is not VEC3");

                    PrimitiveInstance inst;
                    inst.node = f.node;
                    inst.mesh = meshIndex;
                    inst.primitive = static_cast<int64_t>(p);
                    inst.world = world;
                    inst.vertexBase = static_cast<uint32_t>(scene.mesh.vertices.size());
                    inst.vertexCount = static_cast<uint32_t>(pos.count);
                    for (size_t v = 0; v < pos.count; ++v) {
                        geometry::Vertex vert;
                        vert.position = world.transformPoint(Vec3(detail::readComponent(pos, v, 0), detail::readComponent(pos, v, 1), detail::readComponent(pos, v, 2)));
                        scene.mesh.vertices.push_back(vert);
                    }
                    const RawJson* idxRef = prim.get("indices");
                    if (idxRef) {
                        detail::AccessorView idx = detail::viewAccessor(g, idxRef->asInt());
                        for (size_t i = 0; i + 2 < idx.count; i += 3) {
                            uint32_t a = detail::readIndex(idx, i), b = detail::readIndex(idx, i + 1), c = detail::readIndex(idx, i + 2);
                            if (a >= pos.count || b >= pos.count || c >= pos.count) continue;
                            scene.mesh.indices.insert(scene.mesh.indices.end(), {inst.vertexBase + a, inst.vertexBase + b, inst.vertexBase + c});
                        }
                    } else {
                        for (uint32_t i = 0; i + 2 < pos.count; i += 3) {
                            scene.mesh.indices.insert(scene.mesh.indices.end(), {inst.vertexBase + i, inst.vertexBase + i + 1, inst.vertexBase + i + 2});
                        }
                    }
                    scene.instances.push_back(inst);
                }
            }
        }
        if (const RawJson* ch = node.get("children")) {
            for (auto it = ch->arr.rbegin(); it != ch->arr.rend(); ++it) stack.push_back({it->asInt(), world, f.depth + 1});
        }
    }
    if (scene.mesh.indices.empty()) throw std::invalid_argument("GLB contains no triangle geometry");
    return scene;
}

// ============================================================================
// 4. WELDED EDGE GRAPH
// ============================================================================

namespace detail {

class DisjointSet {
public:
    explicit DisjointSet(size_t n) : parent_(n) { std::iota(parent_.begin(), parent_.end(), 0u); }
    uint32_t find(uint32_t x) {
        while (parent_[x] != x) {
            parent_[x] = parent_[parent_[x]];
            x = parent_[x];
        }
        return x;
    }
    void unite(uint32_t a, uint32_t b) {
        a = find(a);
        b = find(b);
        if (a == b) return;
        if (a < b) parent_[b] = a;
        else parent_[a] = b;
    }

private:
    std::vector<uint32_t> parent_;
};

struct Stopwatch {
    std::chrono::steady_clock::time_point start{std::chrono::steady_clock::now()};
    double lapMs() {
        auto now = std::chrono::steady_clock::now();
        double ms = std::chrono::duration<double, std::milli>(now - start).count();
        start = now;
        return ms;
    }
};

class PointGrid {
public:
    PointGrid(const std::vector<Vec3>& points, const std::vector<uint32_t>& ids, float cellSize)
        : points_(points), cell_(cellSize > 0.0f ? cellSize : 1.0f) {
        for (uint32_t id : ids) {
            Key k = keyOf(points[id]);
            cells_[k].push_back(id);
            lo_ = {std::min(lo_[0], k[0]), std::min(lo_[1], k[1]), std::min(lo_[2], k[2])};
            hi_ = {std::max(hi_[0], k[0]), std::max(hi_[1], k[1]), std::max(hi_[2], k[2])};
        }
    }

    int64_t nearest(const Vec3& q) const {
        if (cells_.empty()) return -1;
        auto iabs = [](int64_t x) -> int64_t { return x < 0 ? -x : x; };
        Key c = keyOf(q);
        int64_t maxRing = 0;
        for (int i = 0; i < 3; ++i) maxRing = std::max({maxRing, iabs(c[i] - lo_[i]), iabs(c[i] - hi_[i])});
        int64_t best = -1;
        float bestD = kInf;
        for (int64_t r = 0; r <= maxRing; ++r) {
            for (int64_t dx = -r; dx <= r; ++dx) {
                for (int64_t dy = -r; dy <= r; ++dy) {
                    for (int64_t dz = -r; dz <= r; ++dz) {
                        if (std::max({iabs(dx), iabs(dy), iabs(dz)}) != r) continue;
                        auto it = cells_.find({c[0] + dx, c[1] + dy, c[2] + dz});
                        if (it == cells_.end()) continue;
                        for (uint32_t id : it->second) {
                            float d = (points_[id] - q).lengthSquared();
                            if (d < bestD || (d == bestD && id < best)) {
                                bestD = d;
                                best = id;
                            }
                        }
                    }
                }
            }
            float reach = static_cast<float>(r) * cell_;
            if (best >= 0 && bestD <= reach * reach) break;
        }
        return best;
    }

private:
    using Key = std::array<int64_t, 3>;
    struct KeyHash {
        size_t operator()(const Key& k) const {
            uint64_t h = static_cast<uint64_t>(k[0]) * 73856093ULL ^ static_cast<uint64_t>(k[1]) * 19349663ULL ^ static_cast<uint64_t>(k[2]) * 83492791ULL;
            return static_cast<size_t>(h);
        }
    };
    Key keyOf(const Vec3& p) const {
        return {static_cast<int64_t>(std::floor(p.x / cell_)), static_cast<int64_t>(std::floor(p.y / cell_)), static_cast<int64_t>(std::floor(p.z / cell_))};
    }
    const std::vector<Vec3>& points_;
    float cell_;
    std::unordered_map<Key, std::vector<uint32_t>, KeyHash> cells_;
    Key lo_{std::numeric_limits<int64_t>::max(), std::numeric_limits<int64_t>::max(), std::numeric_limits<int64_t>::max()};
    Key hi_{std::numeric_limits<int64_t>::min(), std::numeric_limits<int64_t>::min(), std::numeric_limits<int64_t>::min()};
};

}  // namespace detail

namespace detail {

/**
 * Conforming bisection of every edge longer than `maxLength` (analysis graph only). Adaptive or
 * decimated meshes mix tiny and huge triangles; without this, bands thinner than the large
 * triangles fragment rings. New vertices are appended, so existing indices stay valid.
 */
inline void refineLongEdges(std::vector<Vec3>& pos, std::vector<uint32_t>& tris, float maxLength) {
    const float max2 = maxLength * maxLength;
    for (int pass = 0; pass < 16; ++pass) {
        std::unordered_map<uint64_t, uint32_t> mid;
        auto key = [](uint32_t a, uint32_t b) {
            if (a > b) std::swap(a, b);
            return (static_cast<uint64_t>(a) << 32) | b;
        };
        for (size_t t = 0; t < tris.size(); t += 3) {
            for (int e = 0; e < 3; ++e) {
                uint32_t a = tris[t + e], b = tris[t + (e + 1) % 3];
                if ((pos[a] - pos[b]).lengthSquared() <= max2) continue;
                if (mid.try_emplace(key(a, b), static_cast<uint32_t>(pos.size())).second) pos.push_back((pos[a] + pos[b]) * 0.5f);
            }
        }
        if (mid.empty()) return;
        std::vector<uint32_t> out;
        out.reserve(tris.size() * 2);
        auto emit = [&](uint32_t a, uint32_t b, uint32_t c) { out.insert(out.end(), {a, b, c}); };
        for (size_t t = 0; t < tris.size(); t += 3) {
            const uint32_t v[3] = {tris[t], tris[t + 1], tris[t + 2]};
            int64_t m[3];
            int splits = 0;
            for (int e = 0; e < 3; ++e) {
                auto it = mid.find(key(v[e], v[(e + 1) % 3]));
                m[e] = it == mid.end() ? -1 : static_cast<int64_t>(it->second);
                splits += m[e] >= 0;
            }
            auto M = [&](int e) { return static_cast<uint32_t>(m[e % 3]); };
            if (splits == 0) {
                emit(v[0], v[1], v[2]);
            } else if (splits == 1) {
                int k = m[0] >= 0 ? 0 : (m[1] >= 0 ? 1 : 2);
                emit(v[k], M(k), v[(k + 2) % 3]);
                emit(M(k), v[(k + 1) % 3], v[(k + 2) % 3]);
            } else if (splits == 2) {
                int k = m[0] < 0 ? 0 : (m[1] < 0 ? 1 : 2);  // unsplit edge (v[k], v[k+1])
                uint32_t A = v[(k + 1) % 3], B = v[(k + 2) % 3], C = v[k];
                uint32_t mAB = M(k + 1), mBC = M(k + 2);
                emit(A, mAB, mBC);
                emit(mAB, B, mBC);
                emit(A, mBC, C);
            } else {
                emit(v[0], M(0), M(2));
                emit(M(0), v[1], M(1));
                emit(M(2), M(1), v[2]);
                emit(M(0), M(1), M(2));
            }
        }
        tris.swap(out);
    }
}

}  // namespace detail

struct WeldedGraph {
    std::vector<uint32_t> remap;  // input vertex -> welded vertex
    std::vector<Vec3> position;
    std::vector<Vec3> normal;
    std::vector<uint32_t> triangles;
    std::vector<uint32_t> adjOffset;
    std::vector<uint32_t> adjVertex;
    std::vector<float> adjLength;
    std::vector<int32_t> component;  // -1: referenced by no triangle
    std::vector<uint32_t> componentSize;
    int32_t mainComponent{-1};
    std::vector<uint32_t> mainVertices;
    size_t boundaryEdges{0};
    size_t nonManifoldEdges{0};
    float bboxDiagonal{0.0f};
    float medianEdge{0.0f};      // of the welded input, before refinement
    size_t inputVertexCount{0};  // welded vertices before refinement; later ones are analysis-only

    size_t size() const { return position.size(); }
    bool inMain(uint32_t v) const { return component[v] == mainComponent; }

    static WeldedGraph build(const ScratchboxMesh& mesh, float weldFrac, float refineMultiple) {
        const size_t n = mesh.vertices.size();
        if (n == 0 || mesh.indices.size() < 3) throw std::invalid_argument("mesh has no triangles to rig");
        WeldedGraph g;
        Vec3 lo(kInf, kInf, kInf), hi(-kInf, -kInf, -kInf);
        for (const auto& v : mesh.vertices) {
            const Vec3& p = v.position;
            if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) throw std::invalid_argument("mesh has non-finite vertex positions");
            lo = Vec3(std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z));
            hi = Vec3(std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z));
        }
        g.bboxDiagonal = (hi - lo).length();
        if (!(g.bboxDiagonal > 0.0f)) throw std::invalid_argument("mesh has zero extent");

        const double inv = 1.0 / std::max<double>(static_cast<double>(weldFrac) * g.bboxDiagonal, 1e-30);
        struct Key {
            int64_t x, y, z;
            bool operator==(const Key& o) const { return x == o.x && y == o.y && z == o.z; }
        };
        struct KeyHash {
            size_t operator()(const Key& k) const {
                return static_cast<size_t>(static_cast<uint64_t>(k.x) * 73856093ULL ^ static_cast<uint64_t>(k.y) * 19349663ULL ^ static_cast<uint64_t>(k.z) * 83492791ULL);
            }
        };
        std::unordered_map<Key, uint32_t, KeyHash> lookup;
        lookup.reserve(n);
        g.remap.resize(n);
        for (size_t i = 0; i < n; ++i) {
            const Vec3& p = mesh.vertices[i].position;
            Key k{std::llround(p.x * inv), std::llround(p.y * inv), std::llround(p.z * inv)};
            auto [it, inserted] = lookup.try_emplace(k, static_cast<uint32_t>(g.position.size()));
            if (inserted) g.position.push_back(p);
            g.remap[i] = it->second;
        }
        const size_t w = g.position.size();

        g.triangles.reserve(mesh.indices.size());
        for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
            uint32_t i0 = mesh.indices[t], i1 = mesh.indices[t + 1], i2 = mesh.indices[t + 2];
            if (i0 >= n || i1 >= n || i2 >= n) continue;
            uint32_t a = g.remap[i0], b = g.remap[i1], c = g.remap[i2];
            if (a == b || b == c || a == c) continue;
            g.triangles.insert(g.triangles.end(), {a, b, c});
        }
        if (g.triangles.empty()) throw std::invalid_argument("mesh has only degenerate triangles");

        auto edgeKey = [](uint32_t a, uint32_t b) {
            if (a > b) std::swap(a, b);
            return (static_cast<uint64_t>(a) << 32) | b;
        };
        auto countEdges = [&](std::unordered_map<uint64_t, uint32_t>& use) {
            use.clear();
            use.reserve(g.triangles.size());
            for (size_t t = 0; t < g.triangles.size(); t += 3) {
                for (int e = 0; e < 3; ++e) ++use[edgeKey(g.triangles[t + e], g.triangles[t + (e + 1) % 3])];
            }
        };
        std::unordered_map<uint64_t, uint32_t> edgeUse;
        countEdges(edgeUse);
        std::vector<float> lengths;
        lengths.reserve(edgeUse.size());
        for (const auto& [key, count] : edgeUse) {
            if (count == 1) ++g.boundaryEdges;
            else if (count > 2) ++g.nonManifoldEdges;
            lengths.push_back((g.position[key >> 32] - g.position[key & 0xFFFFFFFFu]).length());
        }
        std::nth_element(lengths.begin(), lengths.begin() + static_cast<std::ptrdiff_t>(lengths.size() / 2), lengths.end());
        g.medianEdge = lengths[lengths.size() / 2];
        g.inputVertexCount = w;
        if (refineMultiple > 0.0f && g.medianEdge > 0.0f) {
            detail::refineLongEdges(g.position, g.triangles, refineMultiple * g.medianEdge);
            if (g.position.size() != w) countEdges(edgeUse);
        }
        const size_t total = g.position.size();
        std::vector<uint32_t> degree(total, 0);
        for (const auto& kv : edgeUse) {
            ++degree[kv.first >> 32];
            ++degree[kv.first & 0xFFFFFFFFu];
        }
        g.adjOffset.assign(total + 1, 0);
        for (size_t v = 0; v < total; ++v) g.adjOffset[v + 1] = g.adjOffset[v] + degree[v];
        g.adjVertex.resize(g.adjOffset[total]);
        std::vector<uint32_t> cursor(g.adjOffset.begin(), g.adjOffset.end() - 1);
        for (const auto& kv : edgeUse) {
            uint32_t a = static_cast<uint32_t>(kv.first >> 32), b = static_cast<uint32_t>(kv.first & 0xFFFFFFFFu);
            g.adjVertex[cursor[a]++] = b;
            g.adjVertex[cursor[b]++] = a;
        }
        g.adjLength.resize(g.adjVertex.size());
        for (size_t v = 0; v < total; ++v) {
            std::sort(g.adjVertex.begin() + g.adjOffset[v], g.adjVertex.begin() + g.adjOffset[v + 1]);
            for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) g.adjLength[e] = (g.position[g.adjVertex[e]] - g.position[v]).length();
        }

        g.component.assign(total, -1);
        std::vector<uint32_t> queue;
        for (uint32_t s = 0; s < total; ++s) {
            if (g.component[s] >= 0 || degree[s] == 0) continue;
            int32_t id = static_cast<int32_t>(g.componentSize.size());
            g.componentSize.push_back(0);
            queue.assign(1, s);
            g.component[s] = id;
            for (size_t q = 0; q < queue.size(); ++q) {
                uint32_t v = queue[q];
                ++g.componentSize[id];
                for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
                    uint32_t u = g.adjVertex[e];
                    if (g.component[u] < 0) {
                        g.component[u] = id;
                        queue.push_back(u);
                    }
                }
            }
        }
        g.mainComponent = static_cast<int32_t>(std::max_element(g.componentSize.begin(), g.componentSize.end()) - g.componentSize.begin());
        for (uint32_t v = 0; v < total; ++v) if (g.component[v] == g.mainComponent) g.mainVertices.push_back(v);

        g.normal.assign(total, Vec3(0, 0, 0));
        Vec3 centroid(0, 0, 0);
        for (uint32_t v : g.mainVertices) centroid += g.position[v];
        centroid = centroid / static_cast<float>(g.mainVertices.size());
        double signedVolume = 0.0;
        for (size_t t = 0; t < g.triangles.size(); t += 3) {
            uint32_t a = g.triangles[t], b = g.triangles[t + 1], c = g.triangles[t + 2];
            Vec3 pa = g.position[a], pb = g.position[b], pc = g.position[c];
            Vec3 area = (pb - pa).cross(pc - pa);
            g.normal[a] += area;
            g.normal[b] += area;
            g.normal[c] += area;
            if (g.component[a] == g.mainComponent) signedVolume += (pa - centroid).dot((pb - centroid).cross(pc - centroid));
        }
        const float orient = signedVolume < 0.0 ? -1.0f : 1.0f;
        for (auto& nrm : g.normal) {
            float len = nrm.length();
            nrm = len > 0.0f ? nrm * (orient / len) : Vec3(0, 1, 0);
        }
        return g;
    }
};

// ============================================================================
// 5. GEODESICS & AVERAGE GEODESIC DISTANCE
// ============================================================================

class Geodesics {
public:
    /** Multi-source Dijkstra over welded edges; returns the largest finite distance reached. */
    static float run(const WeldedGraph& g, const std::vector<uint32_t>& sources, std::vector<float>& dist) {
        dist.assign(g.size(), kInf);
        using Item = std::pair<float, uint32_t>;
        std::priority_queue<Item, std::vector<Item>, std::greater<Item>> heap;
        for (uint32_t s : sources) {
            dist[s] = 0.0f;
            heap.push({0.0f, s});
        }
        float farthest = 0.0f;
        while (!heap.empty()) {
            auto [d, v] = heap.top();
            heap.pop();
            if (d > dist[v]) continue;
            farthest = std::max(farthest, d);
            for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
                uint32_t u = g.adjVertex[e];
                float nd = d + g.adjLength[e];
                if (nd < dist[u]) {
                    dist[u] = nd;
                    heap.push({nd, u});
                }
            }
        }
        return farthest;
    }

    /** Dijkstra stopped at `limit`. `dist` must hold +inf everywhere on entry; every vertex written is listed in `touched`. */
    static void runBounded(const WeldedGraph& g, const std::vector<uint32_t>& sources, float limit, std::vector<float>& dist, std::vector<uint32_t>& touched) {
        using Item = std::pair<float, uint32_t>;
        std::priority_queue<Item, std::vector<Item>, std::greater<Item>> heap;
        touched.clear();
        for (uint32_t s : sources) {
            if (dist[s] == kInf) touched.push_back(s);
            dist[s] = 0.0f;
            heap.push({0.0f, s});
        }
        while (!heap.empty()) {
            auto [d, v] = heap.top();
            heap.pop();
            if (d > dist[v]) continue;
            for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
                uint32_t u = g.adjVertex[e];
                float nd = d + g.adjLength[e];
                if (nd < limit && nd < dist[u]) {
                    if (dist[u] == kInf) touched.push_back(u);
                    dist[u] = nd;
                    heap.push({nd, u});
                }
            }
        }
    }
};

struct AgdField {
    std::vector<float> value;  // normalised to [0,1] on the main component
    float rawRange{0.0f};      // geodesic-distance units spanned by the normalised range
    float diameter{0.0f};
    int samples{0};
};

/**
 * Lowers `nearest` to the geodesic distance from `source` wherever that is smaller, exploring only those vertices.
 * Exact, not approximate: a vertex whose distance from `source` is not below its `nearest` cannot lie on the shortest
 * path to one whose distance is (float addition of non-negative lengths is monotone), so the vertices it updates get
 * the same float distances a full Dijkstra from `source` computes.
 */
inline void lowerNearest(const WeldedGraph& g, uint32_t source, std::vector<float>& nearest, std::vector<float>& dist, std::vector<uint32_t>& touched) {
    using Item = std::pair<float, uint32_t>;
    std::priority_queue<Item, std::vector<Item>, std::greater<Item>> heap;
    touched.clear();
    dist[source] = 0.0f;
    touched.push_back(source);
    heap.push({0.0f, source});
    while (!heap.empty()) {
        auto [d, v] = heap.top();
        heap.pop();
        if (d > dist[v]) continue;
        for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
            uint32_t u = g.adjVertex[e];
            float nd = d + g.adjLength[e];
            if (nd < dist[u] && nd < nearest[u]) {
                if (dist[u] == kInf) touched.push_back(u);
                dist[u] = nd;
                heap.push({nd, u});
            }
        }
    }
    for (uint32_t v : touched) {
        nearest[v] = std::min(nearest[v], dist[v]);
        dist[v] = kInf;
    }
}

/**
 * Average geodesic distance from `samples` farthest-point sources. The sources are chosen one after another (each is
 * the vertex farthest from all before it), with each step exploring only the region the new source is nearest to;
 * the full distance fields of the sources, which every vertex sums, are then computed in parallel and added in source
 * order, so the field and diameter are the same as running the searches one by one.
 */
inline AgdField computeAgd(const WeldedGraph& g, int samples) {
    AgdField f;
    const auto& main = g.mainVertices;
    std::vector<float> dist;
    f.diameter = Geodesics::run(g, {main.front()}, dist);
    auto argmax = [&](const std::vector<float>& field) {
        uint32_t best = main.front();
        for (uint32_t v : main) if (field[v] > field[best]) best = v;
        return best;
    };
    uint32_t source = argmax(dist);
    f.samples = std::min<int>(samples, static_cast<int>(main.size()));

    // 1. the farthest-point sources, in order
    std::vector<uint32_t> sources;
    sources.reserve(static_cast<size_t>(std::max(f.samples, 0)));
    {
        std::vector<float> nearest(g.size(), kInf), scratch(g.size(), kInf);
        std::vector<uint32_t> touched;
        for (int s = 0; s < f.samples; ++s) {
            sources.push_back(source);
            lowerNearest(g, source, nearest, scratch, touched);
            source = argmax(nearest);
        }
    }

    // 2. their full distance fields, a batch in parallel, summed in source order
    std::vector<double> sum(g.size(), 0.0);
    const size_t threads = std::max<size_t>(1, std::min<size_t>(16, std::thread::hardware_concurrency()));
    const size_t batch = std::min(threads, std::max<size_t>(1, sources.size()));
    std::vector<std::vector<float>> fields(batch);
    std::vector<float> reach(batch, 0.0f);
    for (size_t first = 0; first < sources.size(); first += batch) {
        const size_t count = std::min(batch, sources.size() - first);
        std::atomic<size_t> next{0};
        auto work = [&] {
            for (size_t i; (i = next.fetch_add(1)) < count;) reach[i] = Geodesics::run(g, {sources[first + i]}, fields[i]);
        };
        std::vector<std::thread> pool;
        for (size_t t = 1; t < count; ++t) pool.emplace_back(work);
        work();
        for (auto& t : pool) t.join();
        for (size_t i = 0; i < count; ++i) {
            f.diameter = std::max(f.diameter, reach[i]);
            for (uint32_t v : main) sum[v] += fields[i][v];
        }
    }
    f.value.assign(g.size(), -1.0f);
    double lo = std::numeric_limits<double>::max(), hi = std::numeric_limits<double>::lowest();
    for (uint32_t v : main) {
        lo = std::min(lo, sum[v]);
        hi = std::max(hi, sum[v]);
    }
    double range = hi - lo;
    for (uint32_t v : main) f.value[v] = range > 0.0 ? static_cast<float>((sum[v] - lo) / range) : 0.0f;
    f.rawRange = static_cast<float>(range / std::max(f.samples, 1));
    return f;
}

// ============================================================================
// 6. BAND REEB GRAPH & MEDIAL POSITIONS
// ============================================================================

struct ReebNode {
    std::vector<uint32_t> vertices;
    float level{0.0f};
    Vec3 position{0.0f, 0.0f, 0.0f};
    float radius{0.0f};
    bool alive{true};
};

struct ReebGraph {
    std::vector<ReebNode> nodes;
    std::vector<int32_t> vertexNode;  // welded vertex -> node, -1 outside the main component
    std::vector<std::vector<int32_t>> adjacency;
};

inline ReebGraph buildReebGraph(const WeldedGraph& g, const AgdField& f, int bands, size_t minNodeVertices) {
    const size_t n = g.size();
    std::vector<int32_t> band(n, -1);
    for (uint32_t v : g.mainVertices) band[v] = std::min(bands - 1, static_cast<int>(f.value[v] * static_cast<float>(bands)));

    detail::DisjointSet dsu(n);
    for (uint32_t v : g.mainVertices) {
        for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
            uint32_t u = g.adjVertex[e];
            if (u > v && band[u] == band[v]) dsu.unite(u, v);
        }
    }
    ReebGraph r;
    r.vertexNode.assign(n, -1);
    {
        std::unordered_map<uint32_t, int32_t> rootToNode;
        for (uint32_t v : g.mainVertices) {
            uint32_t root = dsu.find(v);
            auto [it, inserted] = rootToNode.try_emplace(root, static_cast<int32_t>(rootToNode.size()));
            r.vertexNode[v] = it->second;
        }
    }

    for (int pass = 0; pass < 16; ++pass) {
        int32_t nodeCount = 0;
        for (uint32_t v : g.mainVertices) nodeCount = std::max(nodeCount, r.vertexNode[v] + 1);
        std::vector<size_t> sizes(static_cast<size_t>(nodeCount), 0);
        for (uint32_t v : g.mainVertices) ++sizes[static_cast<size_t>(r.vertexNode[v])];
        std::unordered_map<uint64_t, uint32_t> shared;
        for (uint32_t v : g.mainVertices) {
            for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
                uint32_t u = g.adjVertex[e];
                int32_t a = r.vertexNode[v], b = r.vertexNode[u];
                if (u > v && a != b) {
                    ++shared[(static_cast<uint64_t>(std::min(a, b)) << 32) | static_cast<uint32_t>(std::max(a, b))];
                }
            }
        }
        std::vector<int32_t> target(static_cast<size_t>(nodeCount), -1);
        std::vector<uint32_t> bestShare(static_cast<size_t>(nodeCount), 0);
        for (const auto& [key, count] : shared) {
            int32_t a = static_cast<int32_t>(key >> 32), b = static_cast<int32_t>(key & 0xFFFFFFFFu);
            auto consider = [&](int32_t small, int32_t other) {
                if (sizes[small] >= minNodeVertices) return;
                bool better = count > bestShare[small] ||
                              (count == bestShare[small] && target[small] >= 0 &&
                               (sizes[other] > sizes[target[small]] || (sizes[other] == sizes[target[small]] && other < target[small])));
                if (target[small] < 0 || better) {
                    target[small] = other;
                    bestShare[small] = count;
                }
            };
            consider(a, b);
            consider(b, a);
        }
        detail::DisjointSet merge(static_cast<size_t>(nodeCount));
        bool changed = false;
        for (int32_t s = 0; s < nodeCount; ++s) {
            if (target[s] >= 0) {
                merge.unite(static_cast<uint32_t>(s), static_cast<uint32_t>(target[s]));
                changed = true;
            }
        }
        if (!changed) break;
        std::unordered_map<uint32_t, int32_t> compact;
        for (uint32_t v : g.mainVertices) {
            uint32_t root = merge.find(static_cast<uint32_t>(r.vertexNode[v]));
            auto [it, inserted] = compact.try_emplace(root, static_cast<int32_t>(compact.size()));
            r.vertexNode[v] = it->second;
        }
    }

    int32_t nodeCount = 0;
    for (uint32_t v : g.mainVertices) nodeCount = std::max(nodeCount, r.vertexNode[v] + 1);
    r.nodes.resize(static_cast<size_t>(nodeCount));
    for (uint32_t v : g.mainVertices) {
        ReebNode& node = r.nodes[static_cast<size_t>(r.vertexNode[v])];
        node.vertices.push_back(v);
        node.level += f.value[v];
    }
    for (auto& node : r.nodes) node.level /= static_cast<float>(std::max<size_t>(node.vertices.size(), 1));
    r.adjacency.assign(r.nodes.size(), {});
    for (uint32_t v : g.mainVertices) {
        for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
            uint32_t u = g.adjVertex[e];
            int32_t a = r.vertexNode[v], b = r.vertexNode[u];
            if (u > v && a != b) {
                r.adjacency[static_cast<size_t>(a)].push_back(b);
                r.adjacency[static_cast<size_t>(b)].push_back(a);
            }
        }
    }
    for (auto& adj : r.adjacency) {
        std::sort(adj.begin(), adj.end());
        adj.erase(std::unique(adj.begin(), adj.end()), adj.end());
    }
    return r;
}

struct MedialSamples {
    std::vector<Vec3> point;
    std::vector<float> thickness;
    std::vector<uint8_t> valid;
    float hitRatio{0.0f};
};

/** Inward ray along -normal to the opposite wall; the midpoint approximates the medial axis. */
/** Ray queries against the welded surface. Not copyable: the BVH points into `mesh_`. */
class SurfaceRayCaster {
public:
    explicit SurfaceRayCaster(const WeldedGraph& g) {
        mesh_.vertices.reserve(g.size());
        for (const auto& p : g.position) mesh_.vertices.emplace_back(p);
        mesh_.indices = g.triangles;
        tree_.build(mesh_);
    }
    SurfaceRayCaster(const SurfaceRayCaster&) = delete;
    SurfaceRayCaster& operator=(const SurfaceRayCaster&) = delete;

    bool cast(const Vec3& origin, const Vec3& dir, float& t) const {
        bvh::RayHit hit;
        if (!tree_.raycast(Ray(origin, dir), hit) || !std::isfinite(hit.t)) return false;
        t = hit.t;
        return true;
    }

    /**
     * Local thickness under a surface point: a low percentile of hit distances over a cone around
     * the inward normal. Where a limb is fused onto a larger body the straight-in ray runs through
     * both; the tilted rays still meet the limb's own side walls.
     */
    bool coneThickness(const Vec3& p, const Vec3& normal, float offset, float& thickness) const {
        Vec3 d = normal * -1.0f;
        Vec3 helper = std::fabs(d.x) < 0.9f ? Vec3(1, 0, 0) : Vec3(0, 1, 0);
        Vec3 t1 = d.cross(helper).normalized(), t2 = d.cross(t1).normalized();
        std::vector<float> hits;
        const Vec3 origin = p - normal * offset;
        float t = 0.0f;
        if (cast(origin, d, t)) hits.push_back(t + offset);
        const float tilt = 0.61f;  // ~35 degrees
        for (int k = 0; k < 12; ++k) {
            float a = static_cast<float>(k) * 0.5235988f;
            Vec3 dir = d * std::cos(tilt) + (t1 * std::cos(a) + t2 * std::sin(a)) * std::sin(tilt);
            if (cast(origin, dir, t)) hits.push_back((t + offset) * std::cos(tilt));
        }
        if (hits.empty()) return false;
        std::sort(hits.begin(), hits.end());
        thickness = hits[hits.size() / 4];
        return true;
    }

private:
    ScratchboxMesh mesh_;
    bvh::BvhTree tree_;
};

inline MedialSamples computeMedial(const WeldedGraph& g, float diameter, const SurfaceRayCaster& caster) {
    MedialSamples m;
    m.point.assign(g.size(), Vec3(0, 0, 0));
    m.thickness.assign(g.size(), 0.0f);
    m.valid.assign(g.size(), 0);
    const float offset = 1e-4f * g.bboxDiagonal;
    size_t hits = 0;
    for (uint32_t v : g.mainVertices) {
        const Vec3& p = g.position[v];
        const Vec3& nrm = g.normal[v];
        float hitT = 0.0f;
        if (caster.cast(p - nrm * offset, nrm * -1.0f, hitT) && hitT + offset < diameter) {
            float t = hitT + offset;
            m.point[v] = p - nrm * (0.5f * t);
            m.thickness[v] = t;
            m.valid[v] = 1;
            ++hits;
        }
    }
    m.hitRatio = g.mainVertices.empty() ? 0.0f : static_cast<float>(hits) / static_cast<float>(g.mainVertices.size());
    return m;
}

/**
 * Mean medial point of the node's vertices, trimmed to samples within the node's own ring radius of
 * its centroid: at a rounded tip the inward rays run down the whole limb and would drag it back.
 */
inline void placeNode(ReebNode& node, const WeldedGraph& g, const MedialSamples& m) {
    Vec3 centroid(0, 0, 0);
    for (uint32_t v : node.vertices) centroid += g.position[v];
    const float count = static_cast<float>(std::max<size_t>(node.vertices.size(), 1));
    centroid = centroid / count;
    float spread = 0.0f;
    for (uint32_t v : node.vertices) spread += (g.position[v] - centroid).length();
    spread /= count;

    Vec3 medialSum(0, 0, 0);
    size_t valid = 0;
    for (uint32_t v : node.vertices) {
        if (m.valid[v] && (m.point[v] - centroid).length() <= spread) {
            medialSum += m.point[v];
            ++valid;
        }
    }
    node.position = (valid * 10 >= node.vertices.size() * 3 && valid > 0) ? medialSum / static_cast<float>(valid) : centroid;
    float radius = 0.0f;
    for (uint32_t v : node.vertices) radius += (g.position[v] - node.position).length();
    node.radius = radius / count;
}

// ============================================================================
// 7. TREE EXTRACTION (loop cutting, rooting, pruning, hub merging)
// ============================================================================

namespace detail {

inline void removeEdge(std::vector<std::vector<int32_t>>& adj, int32_t a, int32_t b) {
    auto drop = [&](int32_t x, int32_t y) {
        auto& list = adj[static_cast<size_t>(x)];
        list.erase(std::remove(list.begin(), list.end(), y), list.end());
    };
    drop(a, b);
    drop(b, a);
}

}  // namespace detail

namespace detail {

inline void absorbNode(ReebGraph& r, int32_t into, int32_t from) {
    ReebNode& dst = r.nodes[static_cast<size_t>(into)];
    ReebNode& src = r.nodes[static_cast<size_t>(from)];
    for (uint32_t v : src.vertices) {
        r.vertexNode[v] = into;
        dst.vertices.push_back(v);
    }
    src.vertices.clear();
    src.alive = false;
}

inline void contractNodes(ReebGraph& r, const std::vector<int32_t>& members, const WeldedGraph& g) {
    const int32_t keep = *std::min_element(members.begin(), members.end());
    std::unordered_set<int32_t> memberSet(members.begin(), members.end());
    Vec3 weighted(0, 0, 0);
    float weight = 0.0f, levelSum = 0.0f;
    std::vector<int32_t> neighbours;
    for (int32_t m : members) {
        const ReebNode& node = r.nodes[static_cast<size_t>(m)];
        float count = static_cast<float>(node.vertices.size());
        weighted += node.position * count;
        levelSum += node.level * count;
        weight += count;
        for (int32_t w : r.adjacency[static_cast<size_t>(m)]) if (!memberSet.count(w)) neighbours.push_back(w);
    }
    for (int32_t m : members) {
        for (int32_t w : r.adjacency[static_cast<size_t>(m)]) {
            auto& list = r.adjacency[static_cast<size_t>(w)];
            list.erase(std::remove(list.begin(), list.end(), m), list.end());
        }
        r.adjacency[static_cast<size_t>(m)].clear();
        if (m != keep) absorbNode(r, keep, m);
    }
    std::sort(neighbours.begin(), neighbours.end());
    neighbours.erase(std::unique(neighbours.begin(), neighbours.end()), neighbours.end());
    r.adjacency[static_cast<size_t>(keep)] = neighbours;
    for (int32_t w : neighbours) r.adjacency[static_cast<size_t>(w)].push_back(keep);
    ReebNode& dst = r.nodes[static_cast<size_t>(keep)];
    dst.position = weighted / std::max(weight, 1.0f);
    dst.level = levelSum / std::max(weight, 1.0f);
    float radius = 0.0f;
    for (uint32_t v : dst.vertices) radius += (g.position[v] - dst.position).length();
    dst.radius = radius / static_cast<float>(std::max<size_t>(dst.vertices.size(), 1));
}

}  // namespace detail

/**
 * Makes the Reeb graph a tree. A cycle that is short next to its tube radius is a discretisation
 * artifact (one ring split into arcs) and is contracted to a single node. Any other cycle is a real
 * handle and is cut at its lowest-AGD node, on the side of its thinner neighbour: a fused contact
 * (curled finger on a palm, hand on a hip) starts at the loop's lowest point, and the fused end is
 * the thin side.
 */
inline size_t cutLoops(ReebGraph& r, const WeldedGraph& g, float contractRatio, size_t& contracted) {
    const size_t n = r.nodes.size();
    size_t cuts = 0;
    size_t edgeCount = 0;
    for (const auto& a : r.adjacency) edgeCount += a.size();
    const size_t maxSteps = edgeCount / 2 + 1;
    while (true) {
        std::vector<int32_t> parent(n, -2), depth(n, 0);
        int32_t start = -1;
        for (size_t i = 0; i < n; ++i) {
            if (r.nodes[i].alive && (start < 0 || r.nodes[i].level < r.nodes[static_cast<size_t>(start)].level)) start = static_cast<int32_t>(i);
        }
        if (start < 0) return cuts;
        using Item = std::tuple<float, int32_t, int32_t>;
        std::priority_queue<Item, std::vector<Item>, std::greater<Item>> pq;
        pq.push({r.nodes[static_cast<size_t>(start)].level, start, -1});
        while (!pq.empty()) {
            auto [lvl, u, p] = pq.top();
            pq.pop();
            if (parent[static_cast<size_t>(u)] != -2) continue;
            parent[static_cast<size_t>(u)] = p;
            depth[static_cast<size_t>(u)] = p < 0 ? 0 : depth[static_cast<size_t>(p)] + 1;
            for (int32_t w : r.adjacency[static_cast<size_t>(u)]) {
                if (parent[static_cast<size_t>(w)] == -2) pq.push({r.nodes[static_cast<size_t>(w)].level, w, u});
            }
        }
        std::vector<std::pair<int32_t, int32_t>> nonTree;
        for (size_t u = 0; u < n; ++u) {
            for (int32_t w : r.adjacency[u]) {
                if (static_cast<int32_t>(u) < w && parent[u] != w && parent[static_cast<size_t>(w)] != static_cast<int32_t>(u)) {
                    nonTree.push_back({static_cast<int32_t>(u), w});
                }
            }
        }
        if (nonTree.empty()) return cuts;
        if (cuts + contracted > maxSteps) throw std::runtime_error("SB-Rig loop resolution did not converge");

        auto cycleOf = [&](int32_t a, int32_t b) {
            std::vector<int32_t> pathA{a}, pathB{b};
            int32_t x = a, y = b;
            while (depth[static_cast<size_t>(x)] > depth[static_cast<size_t>(y)]) pathA.push_back(x = parent[static_cast<size_t>(x)]);
            while (depth[static_cast<size_t>(y)] > depth[static_cast<size_t>(x)]) pathB.push_back(y = parent[static_cast<size_t>(y)]);
            while (x != y) {
                pathA.push_back(x = parent[static_cast<size_t>(x)]);
                pathB.push_back(y = parent[static_cast<size_t>(y)]);
            }
            pathB.pop_back();  // the LCA is already the last element of pathA
            pathA.insert(pathA.end(), pathB.rbegin(), pathB.rend());
            return pathA;
        };
        auto isArtifact = [&](const std::vector<int32_t>& cycle) {
            float length = 0.0f;
            std::vector<float> radii;
            for (size_t i = 0; i < cycle.size(); ++i) {
                length += (r.nodes[static_cast<size_t>(cycle[i])].position - r.nodes[static_cast<size_t>(cycle[(i + 1) % cycle.size()])].position).length();
                radii.push_back(r.nodes[static_cast<size_t>(cycle[i])].radius);
            }
            std::nth_element(radii.begin(), radii.begin() + static_cast<std::ptrdiff_t>(radii.size() / 2), radii.end());
            return length < contractRatio * radii[radii.size() / 2];
        };
        bool contractedOne = false;
        for (const auto& [a, b] : nonTree) {
            std::vector<int32_t> cycle = cycleOf(a, b);
            if (isArtifact(cycle)) {
                detail::contractNodes(r, cycle, g);
                ++contracted;
                contractedOne = true;
                break;
            }
        }
        if (contractedOne) continue;
        ++cuts;

        std::vector<int32_t> cycle = cycleOf(nonTree.front().first, nonTree.front().second);
        const size_t len = cycle.size();
        size_t low = 0;
        for (size_t i = 1; i < len; ++i) {
            if (r.nodes[static_cast<size_t>(cycle[i])].level < r.nodes[static_cast<size_t>(cycle[low])].level) low = i;
        }
        int32_t s = cycle[low];
        int32_t prev = cycle[(low + len - 1) % len];
        int32_t next = cycle[(low + 1) % len];
        int32_t victim = r.nodes[static_cast<size_t>(prev)].radius <= r.nodes[static_cast<size_t>(next)].radius ? prev : next;
        detail::removeEdge(r.adjacency, s, victim);
    }
}

struct RigTree {
    int32_t root{-1};
    std::vector<int32_t> parent;
    std::vector<std::vector<int32_t>> children;
};

inline RigTree rootTree(const ReebGraph& r, int32_t root) {
    RigTree t;
    t.root = root;
    t.parent.assign(r.nodes.size(), -1);
    t.children.assign(r.nodes.size(), {});
    std::vector<uint8_t> seen(r.nodes.size(), 0);
    std::vector<int32_t> queue{root};
    seen[static_cast<size_t>(root)] = 1;
    for (size_t q = 0; q < queue.size(); ++q) {
        int32_t u = queue[q];
        for (int32_t w : r.adjacency[static_cast<size_t>(u)]) {
            if (seen[static_cast<size_t>(w)]) continue;
            seen[static_cast<size_t>(w)] = 1;
            t.parent[static_cast<size_t>(w)] = u;
            t.children[static_cast<size_t>(u)].push_back(w);
            queue.push_back(w);
        }
    }
    return t;
}

namespace detail {

/** Walks from `start` toward the root until the root or a node with several children. */
inline int32_t junctionAbove(const RigTree& t, const ReebGraph& r, int32_t start, std::vector<int32_t>& path, float& length) {
    path.clear();
    length = 0.0f;
    int32_t x = start;
    while (true) {
        int32_t p = t.parent[static_cast<size_t>(x)];
        length += (r.nodes[static_cast<size_t>(x)].position - r.nodes[static_cast<size_t>(p)].position).length();
        path.push_back(x);
        if (p == t.root || t.children[static_cast<size_t>(p)].size() >= 2) return p;
        x = p;
    }
}

}  // namespace detail

/**
 * Folds leaf branches that protrude less than `minLength` beyond their junction's own ring radius
 * (bumps, wrinkles, knuckles, the sides of a wide palm) into the junction.
 */
inline size_t pruneShortLeaves(ReebGraph& r, RigTree& t, float minLength) {
    size_t pruned = 0;
    std::vector<int32_t> path;
    bool changed = true;
    while (changed) {
        changed = false;
        for (size_t u = 0; u < r.nodes.size(); ++u) {
            int32_t node = static_cast<int32_t>(u);
            if (!r.nodes[u].alive || node == t.root || !t.children[u].empty()) continue;
            float length = 0.0f;
            int32_t junction = detail::junctionAbove(t, r, node, path, length);
            float protrusion = length - r.nodes[static_cast<size_t>(junction)].radius;
            if (protrusion >= minLength || t.children[static_cast<size_t>(junction)].size() < 2) continue;
            for (int32_t x : path) detail::absorbNode(r, junction, x);
            auto& kids = t.children[static_cast<size_t>(junction)];
            kids.erase(std::remove(kids.begin(), kids.end(), path.back()), kids.end());
            ++pruned;
            changed = true;
        }
    }
    return pruned;
}

/**
 * Merges a branch node into the branch node above it when the two splits are less than `minLength`
 * apart along the shape (AGD level gap x `levelScale`), so near-simultaneous splits form one hub.
 */
inline size_t mergeHubs(ReebGraph& r, RigTree& t, float minLength, float levelScale, const WeldedGraph& g) {
    size_t merged = 0;
    std::vector<int32_t> path;
    bool changed = true;
    while (changed) {
        changed = false;
        for (size_t u = 0; u < r.nodes.size() && !changed; ++u) {
            int32_t node = static_cast<int32_t>(u);
            if (!r.nodes[u].alive || node == t.root || t.children[u].size() < 2) continue;
            float length = 0.0f;
            int32_t hub = detail::junctionAbove(t, r, node, path, length);
            float gap = std::fabs(r.nodes[u].level - r.nodes[static_cast<size_t>(hub)].level) * levelScale;
            if (gap >= minLength) continue;

            ReebNode& dst = r.nodes[static_cast<size_t>(hub)];
            Vec3 weighted = dst.position * static_cast<float>(dst.vertices.size());
            float weight = static_cast<float>(dst.vertices.size());
            for (int32_t x : path) {
                const ReebNode& src = r.nodes[static_cast<size_t>(x)];
                weighted += src.position * static_cast<float>(src.vertices.size());
                weight += static_cast<float>(src.vertices.size());
            }
            auto& hubKids = t.children[static_cast<size_t>(hub)];
            hubKids.erase(std::remove(hubKids.begin(), hubKids.end(), path.back()), hubKids.end());
            for (int32_t c : t.children[u]) {
                hubKids.push_back(c);
                t.parent[static_cast<size_t>(c)] = hub;
            }
            t.children[u].clear();
            for (int32_t x : path) detail::absorbNode(r, hub, x);
            dst.position = weighted / std::max(weight, 1.0f);
            float radius = 0.0f;
            for (uint32_t v : dst.vertices) radius += (g.position[v] - dst.position).length();
            dst.radius = radius / static_cast<float>(std::max<size_t>(dst.vertices.size(), 1));
            ++merged;
            changed = true;
        }
    }
    return merged;
}

// ============================================================================
// 8. JOINT PLACEMENT
// ============================================================================

namespace detail {

struct P4 {
    float v[4];
};

inline float pointSegment4(const P4& p, const P4& a, const P4& b) {
    float ab[4], ap[4], len = 0.0f, proj = 0.0f;
    for (int i = 0; i < 4; ++i) {
        ab[i] = b.v[i] - a.v[i];
        ap[i] = p.v[i] - a.v[i];
        len += ab[i] * ab[i];
        proj += ap[i] * ab[i];
    }
    float t = len > 0.0f ? std::clamp(proj / len, 0.0f, 1.0f) : 0.0f;
    float d = 0.0f;
    for (int i = 0; i < 4; ++i) {
        float diff = ap[i] - t * ab[i];
        d += diff * diff;
    }
    return std::sqrt(d);
}

/**
 * Breakpoint indices into `pts` (always includes 0 and the last index): Douglas-Peucker in
 * (position, radiusWeight * radius) space, local bend maxima, spacing clamps, and for leaf chains
 * a minimum count of owning segments.
 */
inline std::vector<size_t> placeBreakpoints(const std::vector<Vec3>& pts, const std::vector<float>& radius, bool leaf,
                                            const SbRigParams& p, float diameter) {
    const size_t n = pts.size();
    if (n <= 1) return {0};
    std::vector<float> s(n, 0.0f);
    for (size_t i = 1; i < n; ++i) s[i] = s[i - 1] + (pts[i] - pts[i - 1]).length();
    const float minBone = p.minBoneFrac * diameter;
    const float maxBone = p.maxBoneFrac * diameter;

    std::vector<uint8_t> mark(n, 0);
    mark[0] = mark[n - 1] = 1;
    std::vector<P4> q(n);
    for (size_t i = 0; i < n; ++i) q[i] = {{pts[i].x, pts[i].y, pts[i].z, p.radiusWeight * radius[i]}};
    std::vector<std::pair<size_t, size_t>> stack{{0, n - 1}};
    const float tol = p.jointDeviationFrac * diameter;
    while (!stack.empty()) {
        auto [a, b] = stack.back();
        stack.pop_back();
        if (b <= a + 1) continue;
        float worst = -1.0f;
        size_t at = a;
        for (size_t i = a + 1; i < b; ++i) {
            float d = pointSegment4(q[i], q[a], q[b]);
            if (d > worst) {
                worst = d;
                at = i;
            }
        }
        if (worst > tol) {
            mark[at] = 1;
            stack.push_back({a, at});
            stack.push_back({at, b});
        }
    }

    std::vector<float> bend(n, 0.0f);
    const size_t w = 2;
    for (size_t i = w; i + w < n; ++i) {
        Vec3 in = pts[i] - pts[i - w], out = pts[i + w] - pts[i];
        float li = in.length(), lo = out.length();
        if (li > 0.0f && lo > 0.0f) bend[i] = std::acos(std::clamp(in.dot(out) / (li * lo), -1.0f, 1.0f));
    }
    for (size_t i = w; i + w < n; ++i) {
        if (bend[i] > p.bendThresholdRad && bend[i] > bend[i - 1] && bend[i] >= bend[i + 1]) mark[i] = 1;
    }

    std::vector<size_t> bp;
    for (size_t i = 0; i < n; ++i) {
        if (!mark[i]) continue;
        if (!bp.empty() && i != n - 1 && s[i] - s[bp.back()] < minBone) continue;
        if (i == n - 1 && bp.size() > 1 && s[i] - s[bp.back()] < minBone) bp.pop_back();
        bp.push_back(i);
    }

    auto splitAt = [&](size_t a, size_t b) -> size_t {
        float target = 0.5f * (s[a] + s[b]);
        size_t best = 0;
        float bestGap = kInf;
        for (size_t i = a + 1; i < b; ++i) {
            float gap = std::fabs(s[i] - target);
            if (gap < bestGap) {
                bestGap = gap;
                best = i;
            }
        }
        return best;
    };
    for (bool again = true; again;) {
        again = false;
        for (size_t k = 0; k + 1 < bp.size(); ++k) {
            if (s[bp[k + 1]] - s[bp[k]] <= maxBone) continue;
            size_t mid = splitAt(bp[k], bp[k + 1]);
            if (mid == 0) continue;
            bp.insert(bp.begin() + static_cast<std::ptrdiff_t>(k + 1), mid);
            again = true;
            break;
        }
    }
    if (leaf && bp.size() - 1 < static_cast<size_t>(p.minLeafChainSegments)) {
        // Without geometric cues, extra joints are spaced evenly: each goes to the segment whose
        // pieces are currently longest, then every segment is cut at equal arc-length fractions.
        const size_t segments = bp.size() - 1;
        std::vector<int> extra(segments, 0);
        for (size_t need = static_cast<size_t>(p.minLeafChainSegments) - segments; need > 0; --need) {
            size_t pick = 0;
            float bestPiece = -1.0f;
            for (size_t k = 0; k < segments; ++k) {
                float piece = (s[bp[k + 1]] - s[bp[k]]) / static_cast<float>(extra[k] + 2);
                if (piece > bestPiece) {
                    bestPiece = piece;
                    pick = k;
                }
            }
            if (bestPiece < 0.5f * minBone) break;
            ++extra[pick];
        }
        std::vector<size_t> refined;
        for (size_t k = 0; k < segments; ++k) {
            refined.push_back(bp[k]);
            for (int m = 1; m <= extra[k]; ++m) {
                float target = s[bp[k]] + (s[bp[k + 1]] - s[bp[k]]) * static_cast<float>(m) / static_cast<float>(extra[k] + 1);
                size_t best = 0;
                float bestGap = kInf;
                for (size_t i = bp[k] + 1; i < bp[k + 1]; ++i) {
                    float gap = std::fabs(s[i] - target);
                    if (gap < bestGap) {
                        bestGap = gap;
                        best = i;
                    }
                }
                if (best != 0 && best != refined.back()) refined.push_back(best);
            }
        }
        refined.push_back(bp.back());
        bp = refined;
    }
    return bp;
}

}  // namespace detail

// ============================================================================
// 9. SOLVER
// ============================================================================

class SbRigSolver {
public:
    static SbRigResult solve(const ScratchboxMesh& mesh, const SbRigParams& params) {
        params.validate();
        SbRigResult res;
        SbRigReport& rep = res.report;
        detail::Stopwatch clock;

        WeldedGraph g = WeldedGraph::build(mesh, params.weldFrac, params.refineEdgeMultiple);
        rep.inputVertices = mesh.vertices.size();
        rep.inputTriangles = mesh.indices.size() / 3;
        rep.weldedVertices = g.inputVertexCount;
        rep.analysisVertices = g.size();
        rep.components = g.componentSize.size();
        rep.mainComponentVertices = g.mainVertices.size();
        rep.boundaryEdges = g.boundaryEdges;
        rep.nonManifoldEdges = g.nonManifoldEdges;
        rep.bboxDiagonal = g.bboxDiagonal;
        rep.timingsMs.push_back({"weld", clock.lapMs()});

        AgdField agd = computeAgd(g, params.agdSamples);
        const float D = agd.diameter;
        if (!(D > 0.0f)) throw std::invalid_argument("mesh main component has zero geodesic extent");
        rep.geodesicDiameter = D;
        rep.agdSamples = agd.samples;
        rep.timingsMs.push_back({"agd", clock.lapMs()});

        // A band must span a few mesh edges, or each ring around a limb fragments into arcs.
        const float medianEdge = g.medianEdge;
        // AGD only chooses the root region: the AGD band around the geodesic centre, or around the
        // root hint. Slicing then uses geodesic distance from that region, whose unit gradient
        // resolves compact features near the centre (a curled finger) as finely as the extremities.
        std::vector<uint32_t> rootRegion;
        {
            uint32_t seed = g.mainVertices.front();
            if (params.hasRootHint) {
                float best = kInf;
                for (uint32_t v : g.mainVertices) {
                    float d = (g.position[v] - params.rootHint).lengthSquared();
                    if (d < best) {
                        best = d;
                        seed = v;
                    }
                }
                rep.rootSource = "root-hint";
            } else {
                for (uint32_t v : g.mainVertices) if (agd.value[v] < agd.value[seed]) seed = v;
                rep.rootSource = "agd-center";
            }
            const float agdBand = std::max(params.bandFrac, agd.rawRange > 0.0f ? params.bandEdgeMultiple * medianEdge / agd.rawRange : params.bandFrac);
            const float half = 0.5f * agdBand;
            std::vector<uint8_t> seen(g.size(), 0);
            rootRegion.push_back(seed);
            seen[seed] = 1;
            for (size_t q = 0; q < rootRegion.size(); ++q) {
                uint32_t v = rootRegion[q];
                for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
                    uint32_t u = g.adjVertex[e];
                    if (!seen[u] && std::fabs(agd.value[u] - agd.value[seed]) <= half) {
                        seen[u] = 1;
                        rootRegion.push_back(u);
                    }
                }
            }
        }
        AgdField field;
        {
            std::vector<float> dist;
            const float reach = Geodesics::run(g, rootRegion, dist);
            field.rawRange = reach;
            field.value.assign(g.size(), -1.0f);
            for (uint32_t v : g.mainVertices) field.value[v] = reach > 0.0f ? dist[v] / reach : 0.0f;
        }

        const float bandFrac = std::max(params.bandFrac, field.rawRange > 0.0f ? params.bandEdgeMultiple * medianEdge / field.rawRange : params.bandFrac);
        const int bands = std::clamp(static_cast<int>(std::lround(1.0 / bandFrac)), 8, 4096);
        const size_t minNodeVertices = std::max<size_t>(3, static_cast<size_t>(params.minNodeFrac * static_cast<float>(g.mainVertices.size())));
        ReebGraph r = buildReebGraph(g, field, bands, minNodeVertices);
        rep.bands = bands;
        rep.reebNodes = r.nodes.size();
        const SurfaceRayCaster caster(g);
        MedialSamples medial = computeMedial(g, D, caster);
        rep.medialHitRatio = medial.hitRatio;
        if (medial.hitRatio < 0.5f) rep.warnings.push_back("inward medial rays hit the opposite wall for only " + std::to_string(static_cast<int>(medial.hitRatio * 100)) + "% of vertices (open or inside-out mesh?); node positions fall back to centroids");
        for (auto& node : r.nodes) placeNode(node, g, medial);
        rep.timingsMs.push_back({"reeb", clock.lapMs()});

        rep.loopsCut = cutLoops(r, g, params.loopContractRatio, rep.loopsContracted);
        const int32_t root = r.vertexNode[rootRegion.front()];
        RigTree t = rootTree(r, root);
        rep.leavesPruned = pruneShortLeaves(r, t, params.minBranchFrac * D);
        rep.hubsMerged = mergeHubs(r, t, params.hubMergeFrac * D, field.rawRange, g);
        rep.timingsMs.push_back({"tree", clock.lapMs()});

        std::vector<int32_t> nodeOwner(r.nodes.size(), -1);
        std::vector<float> jointRadius;
        buildJoints(r, t, g, params, D, res, nodeOwner, jointRadius);

        for (size_t i = 0; i < r.nodes.size(); ++i) {
            if (!r.nodes[i].alive) continue;
            SbRigReport::TreeNode tn;
            tn.id = static_cast<int32_t>(i);
            tn.parent = t.parent[i];
            tn.level = r.nodes[i].level;
            tn.radius = r.nodes[i].radius;
            tn.position = r.nodes[i].position;
            tn.vertices = r.nodes[i].vertices.size();
            tn.ownerJoint = nodeOwner[i];
            rep.tree.push_back(tn);
        }

        std::vector<int32_t> owner(g.size(), -1);
        for (uint32_t v : g.mainVertices) owner[v] = nodeOwner[static_cast<size_t>(r.vertexNode[v])];
        if (!params.chainHints.empty()) applyChainHints(g, caster, r, params, D, res, owner, jointRadius);
        rep.timingsMs.push_back({"joints", clock.lapMs()});

        std::vector<skinning::VertexSkinWeight> welded = paintWeights(g, owner, jointRadius, params.blendScale, D);
        rep.secondaryVerticesBound = bindSecondary(g, welded, owner);
        res.weights.resize(mesh.vertices.size());
        res.vertexOwner.resize(mesh.vertices.size());
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            res.weights[i] = welded[g.remap[i]];
            res.vertexOwner[i] = owner[g.remap[i]];
        }
        rep.timingsMs.push_back({"weights", clock.lapMs()});
        return res;
    }

private:
    static int32_t addJoint(SbRigResult& res, std::vector<float>& jointRadius, const std::string& name, int32_t parent, const Vec3& pos, bool tip, float radius) {
        int32_t id = res.skeleton.addJoint(name, parent, pos);
        res.jointIsTip.push_back(tip ? 1 : 0);
        jointRadius.push_back(radius);
        return id;
    }

    static void buildJoints(const ReebGraph& r, const RigTree& t, const WeldedGraph& g, const SbRigParams& params, float D,
                            SbRigResult& res, std::vector<int32_t>& nodeOwner, std::vector<float>& jointRadius) {
        const ReebNode& rootNode = r.nodes[static_cast<size_t>(t.root)];
        int32_t rootJoint = addJoint(res, jointRadius, "Root", -1, rootNode.position, false, rootNode.radius);
        nodeOwner[static_cast<size_t>(t.root)] = rootJoint;

        std::vector<float> reach(r.nodes.size(), 0.0f);
        {
            std::vector<int32_t> order{t.root};
            for (size_t i = 0; i < order.size(); ++i) {
                for (int32_t c : t.children[static_cast<size_t>(order[i])]) order.push_back(c);
            }
            for (auto it = order.rbegin(); it != order.rend(); ++it) {
                for (int32_t c : t.children[static_cast<size_t>(*it)]) {
                    float len = (r.nodes[static_cast<size_t>(c)].position - r.nodes[static_cast<size_t>(*it)].position).length() + reach[static_cast<size_t>(c)];
                    reach[static_cast<size_t>(*it)] = std::max(reach[static_cast<size_t>(*it)], len);
                }
            }
        }
        auto sortedChildren = [&](int32_t u) {
            std::vector<int32_t> kids = t.children[static_cast<size_t>(u)];
            std::stable_sort(kids.begin(), kids.end(), [&](int32_t a, int32_t b) { return reach[static_cast<size_t>(a)] > reach[static_cast<size_t>(b)]; });
            return kids;
        };

        struct Pending { int32_t hangNode; int32_t hangJoint; int32_t first; };
        std::vector<Pending> stack;
        {
            auto kids = sortedChildren(t.root);
            for (auto it = kids.rbegin(); it != kids.rend(); ++it) stack.push_back({t.root, rootJoint, *it});
        }
        const bool rootHasSingleChild = t.children[static_cast<size_t>(t.root)].size() == 1;
        int chainNumber = 0;
        while (!stack.empty()) {
            Pending job = stack.back();
            stack.pop_back();
            std::vector<int32_t> nodes{job.first};
            while (t.children[static_cast<size_t>(nodes.back())].size() == 1) nodes.push_back(t.children[static_cast<size_t>(nodes.back())].front());
            const bool leaf = t.children[static_cast<size_t>(nodes.back())].empty();

            std::vector<Vec3> pts;
            std::vector<float> radius;
            for (int32_t x : nodes) {
                pts.push_back(r.nodes[static_cast<size_t>(x)].position);
                radius.push_back(r.nodes[static_cast<size_t>(x)].radius);
            }
            for (size_t i = 1; i + 1 < pts.size(); ++i) {
                pts[i] = (r.nodes[static_cast<size_t>(nodes[i - 1])].position + r.nodes[static_cast<size_t>(nodes[i])].position + r.nodes[static_cast<size_t>(nodes[i + 1])].position) / 3.0f;
            }
            if (leaf) {
                const ReebNode& last = r.nodes[static_cast<size_t>(nodes.back())];
                uint32_t tipVertex = last.vertices.front();
                float bestDist = -1.0f;
                const Vec3 hang = r.nodes[static_cast<size_t>(job.hangNode)].position;
                for (uint32_t v : last.vertices) {
                    float d = (g.position[v] - hang).lengthSquared();
                    if (d > bestDist) {
                        bestDist = d;
                        tipVertex = v;
                    }
                }
                pts.push_back(g.position[tipVertex]);
                radius.push_back(last.radius);
            }

            std::vector<size_t> bp = detail::placeBreakpoints(pts, radius, leaf, params, D);
            if (job.hangNode == t.root && rootHasSingleChild && bp.size() > 2 &&
                (pts[bp.front()] - r.nodes[static_cast<size_t>(t.root)].position).length() < params.minBoneFrac * D) {
                bp.erase(bp.begin());
            }

            SbRigChain chain;
            chain.name = "Chain" + std::to_string(++chainNumber);
            chain.parentJoint = job.hangJoint;
            chain.leaf = leaf;
            for (size_t i = 1; i < pts.size(); ++i) chain.length += (pts[i] - pts[i - 1]).length();

            std::vector<int32_t> bpJoint(bp.size(), -1);
            int32_t prev = job.hangJoint;
            for (size_t k = 0; k < bp.size(); ++k) {
                const bool isTip = leaf && k + 1 == bp.size();
                if (isTip && !params.emitTipJoints) break;
                float jr = bp[k] < nodes.size() ? radius[bp[k]] : radius.back();
                std::string name = chain.name + "Seg" + std::to_string(chain.joints.size() + 1);
                prev = addJoint(res, jointRadius, name, prev, pts[bp[k]], isTip, jr);
                bpJoint[k] = prev;
                chain.joints.push_back(prev);
            }

            size_t k = 0;
            for (size_t i = 0; i < nodes.size(); ++i) {
                while (k + 1 < bp.size() && bp[k + 1] <= i) ++k;
                int32_t ownerJoint = (bp[k] <= i && bpJoint[k] >= 0) ? bpJoint[k] : job.hangJoint;
                nodeOwner[static_cast<size_t>(nodes[i])] = ownerJoint;
            }

            res.chains.push_back(chain);
            if (!leaf) {
                int32_t branchJoint = bpJoint.back() >= 0 ? bpJoint.back() : job.hangJoint;
                auto kids = sortedChildren(nodes.back());
                for (auto it = kids.rbegin(); it != kids.rend(); ++it) stack.push_back({nodes.back(), branchJoint, *it});
            }
        }
        for (size_t i = 0; i < jointRadius.size(); ++i) {
            if (!(jointRadius[i] > 0.0f)) jointRadius[i] = 1e-3f * D;
        }
    }

    /**
     * Hint points on (or within 1% of D of) the surface, e.g. picked from a render, are pulled
     * inward by half the cone thickness under them; points farther from the surface are taken as
     * interior axis points and used as given. Hinted chains parent to the geometry-derived skeleton.
     */
    static void applyChainHints(const WeldedGraph& g, const SurfaceRayCaster& caster, const ReebGraph& r, const SbRigParams& params, float D,
                                SbRigResult& res, std::vector<int32_t>& owner, std::vector<float>& jointRadius) {
        detail::PointGrid grid(g.position, g.mainVertices, g.bboxDiagonal / 96.0f);
        const size_t autoJoints = res.skeleton.joints.size();
        const float offset = 1e-4f * g.bboxDiagonal;
        int chainNumber = static_cast<int>(res.chains.size());
        for (const auto& hint : params.chainHints) {
            std::vector<Vec3> pts;
            std::vector<float> radius;
            for (const Vec3& h : hint) {
                uint32_t v = static_cast<uint32_t>(grid.nearest(h));
                const Vec3& p = g.position[v];
                float thickness = 0.0f;
                const bool surfacePoint = (h - p).length() <= 0.01f * D;
                const bool measured = caster.coneThickness(p, g.normal[v], offset, thickness);
                if (surfacePoint && measured) pts.push_back(p - g.normal[v] * (0.5f * thickness));
                else pts.push_back(h);
                radius.push_back(measured ? 0.5f * thickness : r.nodes[static_cast<size_t>(r.vertexNode[v])].radius);
            }
            for (bool again = true; again && pts.size() - 1 < static_cast<size_t>(params.minLeafChainSegments);) {
                again = false;
                size_t longest = 0;
                float best = 0.0f;
                for (size_t i = 0; i + 1 < pts.size(); ++i) {
                    float len = (pts[i + 1] - pts[i]).length();
                    if (len > best) {
                        best = len;
                        longest = i;
                    }
                }
                if (best >= params.minBoneFrac * D) {
                    pts.insert(pts.begin() + static_cast<std::ptrdiff_t>(longest + 1), (pts[longest] + pts[longest + 1]) * 0.5f);
                    radius.insert(radius.begin() + static_cast<std::ptrdiff_t>(longest + 1), 0.5f * (radius[longest] + radius[longest + 1]));
                    again = true;
                }
            }

            int32_t parent = 0;
            float bestParent = kInf;
            for (size_t j = 0; j < autoJoints; ++j) {
                if (res.jointIsTip[j]) continue;
                float d = (res.skeleton.joints[j].restPosition - pts.front()).lengthSquared();
                if (d < bestParent) {
                    bestParent = d;
                    parent = static_cast<int32_t>(j);
                }
            }

            SbRigChain chain;
            chain.name = "Chain" + std::to_string(++chainNumber);
            chain.parentJoint = parent;
            chain.leaf = true;
            chain.hinted = true;
            float tube = 0.0f;
            for (float rr : radius) tube += rr;
            tube = 1.25f * tube / static_cast<float>(radius.size());
            std::vector<int32_t> segJoint;
            int32_t prev = parent;
            for (size_t i = 0; i < pts.size(); ++i) {
                const bool isTip = i + 1 == pts.size();
                if (i > 0) chain.length += (pts[i] - pts[i - 1]).length();
                if (isTip && !params.emitTipJoints) break;
                prev = addJoint(res, jointRadius, chain.name + "Seg" + std::to_string(i + 1), prev, pts[i], isTip, std::max(tube, 1e-3f * D));
                chain.joints.push_back(prev);
                if (!isTip) segJoint.push_back(prev);
            }
            for (uint32_t v : g.mainVertices) {
                const Vec3& p = g.position[v];
                float best = kInf;
                size_t seg = 0;
                for (size_t i = 0; i + 1 < pts.size(); ++i) {
                    Vec3 ab = pts[i + 1] - pts[i];
                    float len2 = ab.lengthSquared();
                    float tt = len2 > 0.0f ? std::clamp((p - pts[i]).dot(ab) / len2, 0.0f, 1.0f) : 0.0f;
                    float d = (p - (pts[i] + ab * tt)).length();
                    if (d < best) {
                        best = d;
                        seg = i;
                    }
                }
                if (best < tube) owner[v] = segJoint[seg];
            }
            res.chains.push_back(chain);
        }
    }

    static std::vector<skinning::VertexSkinWeight> paintWeights(const WeldedGraph& g, const std::vector<int32_t>& owner,
                                                                 const std::vector<float>& jointRadius, float blendScale, float D) {
        const size_t n = g.size();
        struct Slots {
            std::array<int32_t, 4> joint{-1, -1, -1, -1};
            std::array<float, 4> weight{0, 0, 0, 0};
        };
        std::vector<Slots> slots(n);
        auto insert = [&](uint32_t v, int32_t j, float w) {
            if (w <= 0.0f) return;
            Slots& s = slots[v];
            for (int k = 0; k < 4; ++k) {
                if (s.joint[k] == j) {
                    s.weight[k] = std::max(s.weight[k], w);
                    return;
                }
            }
            int weakest = 0;
            for (int k = 1; k < 4; ++k) if (s.weight[k] < s.weight[weakest]) weakest = k;
            if (s.joint[weakest] < 0 || w > s.weight[weakest]) {
                s.joint[weakest] = j;
                s.weight[weakest] = w;
            }
        };

        std::vector<std::vector<uint32_t>> region(jointRadius.size());
        for (uint32_t v : g.mainVertices) {
            if (owner[v] >= 0) {
                region[static_cast<size_t>(owner[v])].push_back(v);
                insert(v, owner[v], 1.0f);
            }
        }
        std::vector<float> dist(n, kInf);
        std::vector<uint32_t> touched, sources;
        for (size_t j = 0; j < region.size(); ++j) {
            if (region[j].empty()) continue;
            const int32_t joint = static_cast<int32_t>(j);
            sources.clear();
            for (uint32_t v : region[j]) {
                for (uint32_t e = g.adjOffset[v]; e < g.adjOffset[v + 1]; ++e) {
                    if (owner[g.adjVertex[e]] != joint) {
                        sources.push_back(v);
                        break;
                    }
                }
            }
            if (sources.empty()) continue;
            const float beta = std::max(blendScale * jointRadius[j], 1e-6f * D);
            Geodesics::runBounded(g, sources, beta, dist, touched);
            for (uint32_t v : touched) {
                if (owner[v] != joint && owner[v] >= 0) {
                    float x = std::clamp(dist[v] / beta, 0.0f, 1.0f);
                    insert(v, joint, 1.0f - x * x * (3.0f - 2.0f * x));
                }
                dist[v] = kInf;
            }
        }

        std::vector<skinning::VertexSkinWeight> out(n);
        for (size_t v = 0; v < n; ++v) {
            Slots& s = slots[v];
            std::array<int, 4> order{0, 1, 2, 3};
            std::sort(order.begin(), order.end(), [&](int a, int b) { return s.weight[a] > s.weight[b]; });
            skinning::VertexSkinWeight w;
            for (int k = 0; k < 4; ++k) {
                int src = order[k];
                w.joints[k] = s.joint[src] >= 0 ? static_cast<uint16_t>(s.joint[src]) : 0;
                w.weights[k] = s.joint[src] >= 0 ? s.weight[src] : 0.0f;
            }
            w.normalize();
            out[v] = w;
        }
        return out;
    }

    /** Each secondary component is bound rigidly to the main-component vertex closest to it. */
    static size_t bindSecondary(const WeldedGraph& g, std::vector<skinning::VertexSkinWeight>& welded, std::vector<int32_t>& owner) {
        if (g.mainVertices.size() == g.size()) return 0;
        detail::PointGrid grid(g.position, g.mainVertices, g.bboxDiagonal / 96.0f);
        std::vector<std::vector<uint32_t>> groups(g.componentSize.size());
        std::vector<uint32_t> loose;
        for (uint32_t v = 0; v < g.size(); ++v) {
            if (g.inMain(v)) continue;
            if (g.component[v] < 0) loose.push_back(v);
            else groups[static_cast<size_t>(g.component[v])].push_back(v);
        }
        size_t bound = 0;
        auto bindGroup = [&](const uint32_t* members, size_t count) {
            const size_t stride = std::max<size_t>(1, count / 16);
            int64_t best = -1;
            float bestDist = kInf;
            for (size_t i = 0; i < count; i += stride) {
                int64_t nearest = grid.nearest(g.position[members[i]]);
                if (nearest < 0) continue;
                float d = (g.position[static_cast<size_t>(nearest)] - g.position[members[i]]).lengthSquared();
                if (d < bestDist) {
                    bestDist = d;
                    best = nearest;
                }
            }
            if (best < 0) return;
            for (size_t i = 0; i < count; ++i) {
                welded[members[i]] = welded[static_cast<size_t>(best)];
                owner[members[i]] = owner[static_cast<size_t>(best)];
            }
            bound += count;
        };
        for (const auto& group : groups) if (!group.empty()) bindGroup(group.data(), group.size());
        for (uint32_t v : loose) bindGroup(&v, 1);
        return bound;
    }
};

// ============================================================================
// 10. TEXTURE-PRESERVING GLB SKIN ATTACHMENT
// ============================================================================

class SbRigGlbPatcher {
public:
    /**
     * Returns `glb` with the rig attached. Existing bytes, accessors, images, materials and
     * extensions are untouched; skin data is appended. A skinned node with a non-identity world
     * transform is moved to the scene root with an identity transform (its inverse-bind matrices
     * carry the transform), so spec-conformant viewers and three.js agree.
     */
    static std::vector<uint8_t> attach(GlbContainer glb, const SceneGeometry& scene, const SbRigResult& rig) {
        RawJson& json = glb.json;
        if (const RawJson* skins = json.get("skins"); skins && !skins->arr.empty()) {
            throw std::invalid_argument("input already has a skin; SB-Rig v1 does not re-rig skinned assets");
        }
        size_t total = 0;
        for (const auto& inst : scene.instances) total += inst.vertexCount;
        if (rig.weights.size() != total) throw std::logic_error("rig vertex count does not match the GLB scene");
        if (const RawJson* buffers = json.get("buffers"); buffers && !buffers->arr.empty() && buffers->arr[0].get("uri")) {
            throw std::invalid_argument("buffer 0 is external; SB-Rig patches self-contained GLB files only");
        }

        auto& bin = glb.bin;
        // Create every top-level array first: adding keys later would reallocate json.obj and
        // invalidate the references taken below.
        for (const char* key : {"nodes", "bufferViews", "accessors", "meshes", "skins", "buffers"}) {
            RawJson* v = json.get(key);
            if (!v || v->kind != RawJson::Array) json.set(key, RawJson::array());
        }
        RawJson& nodes = *json.get("nodes");
        RawJson& views = *json.get("bufferViews");
        RawJson& accessors = *json.get("accessors");
        RawJson& meshes = *json.get("meshes");
        RawJson& skins = *json.get("skins");
        RawJson& buffers = *json.get("buffers");

        auto appendView = [&](const void* data, size_t bytes, int target) -> int64_t {
            while (bin.size() % 4) bin.push_back(0);
            size_t offset = bin.size();
            bin.insert(bin.end(), static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + bytes);
            RawJson view = RawJson::object();
            view.set("buffer", RawJson::number(0));
            view.set("byteOffset", RawJson::number(static_cast<double>(offset)));
            view.set("byteLength", RawJson::number(static_cast<double>(bytes)));
            if (target) view.set("target", RawJson::number(target));
            views.push(std::move(view));
            return static_cast<int64_t>(views.arr.size() - 1);
        };
        auto appendAccessor = [&](int64_t view, int componentType, size_t count, const char* type) -> int64_t {
            RawJson acc = RawJson::object();
            acc.set("bufferView", RawJson::number(static_cast<double>(view)));
            acc.set("componentType", RawJson::number(componentType));
            acc.set("count", RawJson::number(static_cast<double>(count)));
            acc.set("type", RawJson::string(type));
            accessors.push(std::move(acc));
            return static_cast<int64_t>(accessors.arr.size() - 1);
        };

        for (const auto& inst : scene.instances) {
            std::vector<uint16_t> joints(static_cast<size_t>(inst.vertexCount) * 4);
            std::vector<float> weights(static_cast<size_t>(inst.vertexCount) * 4);
            for (uint32_t v = 0; v < inst.vertexCount; ++v) {
                const auto& w = rig.weights[inst.vertexBase + v];
                for (int k = 0; k < 4; ++k) {
                    joints[v * 4 + k] = w.joints[k];
                    weights[v * 4 + k] = w.weights[k];
                }
            }
            int64_t jAcc = appendAccessor(appendView(joints.data(), joints.size() * sizeof(uint16_t), 34962), 5123, inst.vertexCount, "VEC4");
            int64_t wAcc = appendAccessor(appendView(weights.data(), weights.size() * sizeof(float), 34962), 5126, inst.vertexCount, "VEC4");
            RawJson& prim = meshes.arr.at(static_cast<size_t>(inst.mesh)).get("primitives")->arr.at(static_cast<size_t>(inst.primitive));
            RawJson* attrs = prim.get("attributes");
            attrs->set("JOINTS_0", RawJson::number(static_cast<double>(jAcc)));
            attrs->set("WEIGHTS_0", RawJson::number(static_cast<double>(wAcc)));
        }

        const auto& joints = rig.skeleton.joints;
        const int64_t jointBase = static_cast<int64_t>(nodes.arr.size());
        for (const auto& j : joints) {
            Vec3 local = j.parentIndex >= 0 ? j.restPosition - joints[static_cast<size_t>(j.parentIndex)].restPosition : j.restPosition;
            RawJson node = RawJson::object();
            node.set("name", RawJson::string(j.name));
            node.set("translation", RawJson::vec3(local));
            nodes.push(std::move(node));
        }
        std::vector<int64_t> rootJoints;
        for (size_t i = 0; i < joints.size(); ++i) {
            int32_t parent = joints[i].parentIndex;
            if (parent < 0) {
                rootJoints.push_back(jointBase + static_cast<int64_t>(i));
                continue;
            }
            RawJson& parentNode = nodes.arr[static_cast<size_t>(jointBase + parent)];
            RawJson* children = parentNode.get("children");
            if (!children) children = &parentNode.set("children", RawJson::array());
            children->push(RawJson::number(static_cast<double>(jointBase + static_cast<int64_t>(i))));
        }

        RawJson* sceneNodes = nullptr;
        if (RawJson* scenes = json.get("scenes"); scenes && !scenes->arr.empty()) {
            int64_t sceneIndex = json.get("scene") ? json.get("scene")->asInt(0) : 0;
            if (sceneIndex < 0 || sceneIndex >= static_cast<int64_t>(scenes->arr.size())) sceneIndex = 0;
            RawJson& sc = scenes->arr[static_cast<size_t>(sceneIndex)];
            sceneNodes = sc.get("nodes");
            if (!sceneNodes) sceneNodes = &sc.set("nodes", RawJson::array());
        }
        for (int64_t rj : rootJoints) if (sceneNodes) sceneNodes->push(RawJson::number(static_cast<double>(rj)));

        std::vector<int64_t> skinnedNodes;
        for (const auto& inst : scene.instances) {
            if (std::find(skinnedNodes.begin(), skinnedNodes.end(), inst.node) != skinnedNodes.end()) continue;
            skinnedNodes.push_back(inst.node);
            std::vector<float> ibm(joints.size() * 16);
            for (size_t j = 0; j < joints.size(); ++j) {
                Mat4 m = Mat4::translation(joints[j].restPosition * -1.0f) * inst.world;
                std::copy(m.m.begin(), m.m.end(), ibm.begin() + static_cast<std::ptrdiff_t>(j * 16));
            }
            int64_t ibmAcc = appendAccessor(appendView(ibm.data(), ibm.size() * sizeof(float), 0), 5126, joints.size(), "MAT4");
            RawJson skin = RawJson::object();
            skin.set("name", RawJson::string("SbRig"));
            skin.set("inverseBindMatrices", RawJson::number(static_cast<double>(ibmAcc)));
            RawJson list = RawJson::array();
            for (size_t j = 0; j < joints.size(); ++j) list.push(RawJson::number(static_cast<double>(jointBase + static_cast<int64_t>(j))));
            skin.set("joints", std::move(list));
            if (!rootJoints.empty()) skin.set("skeleton", RawJson::number(static_cast<double>(rootJoints.front())));
            RawJson extras = RawJson::object();
            extras.set("generator", RawJson::string("SB-Rig"));
            skin.set("extras", std::move(extras));
            skins.push(std::move(skin));
            RawJson& meshNode = nodes.arr[static_cast<size_t>(inst.node)];
            meshNode.set("skin", RawJson::number(static_cast<double>(skins.arr.size() - 1)));
            if (!detail::isIdentity(inst.world)) detachToRoot(json, inst.node, sceneNodes);
        }

        if (buffers.arr.empty()) buffers.push(RawJson::object());
        while (bin.size() % 4) bin.push_back(0);
        buffers.arr[0].set("byteLength", RawJson::number(static_cast<double>(bin.size())));
        return glb.serialize();
    }

private:
    static void detachToRoot(RawJson& json, int64_t nodeIndex, RawJson* sceneNodes) {
        RawJson& nodes = *json.get("nodes");
        RawJson& node = nodes.arr[static_cast<size_t>(nodeIndex)];
        if (const RawJson* ch = node.get("children"); ch && !ch->arr.empty()) {
            throw std::invalid_argument("skinned node " + std::to_string(nodeIndex) + " has a non-identity transform and children; SB-Rig v1 cannot re-home it");
        }
        auto dropRef = [&](RawJson& list) {
            list.arr.erase(std::remove_if(list.arr.begin(), list.arr.end(), [&](const RawJson& v) { return v.asInt() == nodeIndex; }), list.arr.end());
        };
        for (auto& other : nodes.arr) {
            if (RawJson* ch = other.get("children")) dropRef(*ch);
        }
        if (sceneNodes) {
            dropRef(*sceneNodes);
            sceneNodes->push(RawJson::number(static_cast<double>(nodeIndex)));
        }
        for (const char* key : {"matrix", "translation", "rotation", "scale"}) node.erase(key);
    }
};

// ============================================================================
// 11. REPORT & FILE PIPELINE
// ============================================================================

inline RawJson reportJson(const SbRigResult& r, const SbRigParams& params, bool includeTree = false) {
    const auto& joints = r.skeleton.joints;
    RawJson root = RawJson::object();
    if (includeTree) {
        RawJson tree = RawJson::array();
        for (const auto& n : r.report.tree) {
            RawJson node = RawJson::object();
            node.set("id", RawJson::number(n.id));
            node.set("parent", RawJson::number(n.parent));
            node.set("level", RawJson::number(n.level));
            node.set("radius", RawJson::number(n.radius));
            node.set("position", RawJson::vec3(n.position));
            node.set("vertices", RawJson::number(static_cast<double>(n.vertices)));
            node.set("ownerJoint", n.ownerJoint >= 0 ? RawJson::string(joints[static_cast<size_t>(n.ownerJoint)].name) : RawJson{});
            tree.push(std::move(node));
        }
        root.set("tree", std::move(tree));
    }
    root.set("generator", RawJson::string("SB-Rig"));
    root.set("version", RawJson::number(1));

    RawJson jointList = RawJson::array();
    for (size_t i = 0; i < joints.size(); ++i) {
        RawJson j = RawJson::object();
        j.set("name", RawJson::string(joints[i].name));
        j.set("parent", joints[i].parentIndex >= 0 ? RawJson::string(joints[static_cast<size_t>(joints[i].parentIndex)].name) : RawJson{});
        j.set("position", RawJson::vec3(joints[i].restPosition));
        j.set("tip", RawJson::boolean(r.jointIsTip[i] != 0));
        jointList.push(std::move(j));
    }
    root.set("joints", std::move(jointList));

    RawJson chainList = RawJson::array();
    for (const auto& c : r.chains) {
        RawJson j = RawJson::object();
        j.set("name", RawJson::string(c.name));
        j.set("parentJoint", c.parentJoint >= 0 ? RawJson::string(joints[static_cast<size_t>(c.parentJoint)].name) : RawJson{});
        RawJson names = RawJson::array();
        for (int32_t id : c.joints) names.push(RawJson::string(joints[static_cast<size_t>(id)].name));
        j.set("joints", std::move(names));
        j.set("leaf", RawJson::boolean(c.leaf));
        j.set("hinted", RawJson::boolean(c.hinted));
        j.set("length", RawJson::number(c.length));
        if (!c.joints.empty()) {
            j.set("basePosition", RawJson::vec3(joints[static_cast<size_t>(c.joints.front())].restPosition));
            j.set("endPosition", RawJson::vec3(joints[static_cast<size_t>(c.joints.back())].restPosition));
        }
        chainList.push(std::move(j));
    }
    root.set("chains", std::move(chainList));

    const SbRigReport& rep = r.report;
    RawJson stats = RawJson::object();
    stats.set("inputVertices", RawJson::number(static_cast<double>(rep.inputVertices)));
    stats.set("inputTriangles", RawJson::number(static_cast<double>(rep.inputTriangles)));
    stats.set("weldedVertices", RawJson::number(static_cast<double>(rep.weldedVertices)));
    stats.set("analysisVertices", RawJson::number(static_cast<double>(rep.analysisVertices)));
    stats.set("components", RawJson::number(static_cast<double>(rep.components)));
    stats.set("mainComponentVertices", RawJson::number(static_cast<double>(rep.mainComponentVertices)));
    stats.set("secondaryVerticesBound", RawJson::number(static_cast<double>(rep.secondaryVerticesBound)));
    stats.set("boundaryEdges", RawJson::number(static_cast<double>(rep.boundaryEdges)));
    stats.set("nonManifoldEdges", RawJson::number(static_cast<double>(rep.nonManifoldEdges)));
    stats.set("bboxDiagonal", RawJson::number(rep.bboxDiagonal));
    stats.set("geodesicDiameter", RawJson::number(rep.geodesicDiameter));
    stats.set("agdSamples", RawJson::number(rep.agdSamples));
    stats.set("bands", RawJson::number(rep.bands));
    stats.set("reebNodes", RawJson::number(static_cast<double>(rep.reebNodes)));
    stats.set("loopsCut", RawJson::number(static_cast<double>(rep.loopsCut)));
    stats.set("loopsContracted", RawJson::number(static_cast<double>(rep.loopsContracted)));
    stats.set("leavesPruned", RawJson::number(static_cast<double>(rep.leavesPruned)));
    stats.set("hubsMerged", RawJson::number(static_cast<double>(rep.hubsMerged)));
    stats.set("medialHitRatio", RawJson::number(rep.medialHitRatio));
    stats.set("rootSource", RawJson::string(rep.rootSource));
    stats.set("jointCount", RawJson::number(static_cast<double>(joints.size())));
    stats.set("chainCount", RawJson::number(static_cast<double>(r.chains.size())));
    stats.set("leafChainCount", RawJson::number(static_cast<double>(r.leafCount())));
    root.set("stats", std::move(stats));

    RawJson timings = RawJson::object();
    double total = 0.0;
    for (const auto& [name, ms] : rep.timingsMs) {
        timings.set(name, RawJson::number(ms));
        total += ms;
    }
    timings.set("total", RawJson::number(total));
    root.set("timingsMs", std::move(timings));

    RawJson warnings = RawJson::array();
    for (const auto& w : rep.warnings) warnings.push(RawJson::string(w));
    root.set("warnings", std::move(warnings));

    RawJson p = RawJson::object();
    p.set("weldFrac", RawJson::number(params.weldFrac));
    p.set("refineEdgeMultiple", RawJson::number(params.refineEdgeMultiple));
    p.set("agdSamples", RawJson::number(params.agdSamples));
    p.set("bandFrac", RawJson::number(params.bandFrac));
    p.set("bandEdgeMultiple", RawJson::number(params.bandEdgeMultiple));
    p.set("loopContractRatio", RawJson::number(params.loopContractRatio));
    p.set("minNodeFrac", RawJson::number(params.minNodeFrac));
    p.set("minBranchFrac", RawJson::number(params.minBranchFrac));
    p.set("hubMergeFrac", RawJson::number(params.hubMergeFrac));
    p.set("jointDeviationFrac", RawJson::number(params.jointDeviationFrac));
    p.set("radiusWeight", RawJson::number(params.radiusWeight));
    p.set("bendThresholdRad", RawJson::number(params.bendThresholdRad));
    p.set("minBoneFrac", RawJson::number(params.minBoneFrac));
    p.set("maxBoneFrac", RawJson::number(params.maxBoneFrac));
    p.set("minLeafChainSegments", RawJson::number(params.minLeafChainSegments));
    p.set("blendScale", RawJson::number(params.blendScale));
    p.set("emitTipJoints", RawJson::boolean(params.emitTipJoints));
    if (params.hasRootHint) p.set("rootHint", RawJson::vec3(params.rootHint));
    if (!params.chainHints.empty()) {
        RawJson hints = RawJson::array();
        for (const auto& h : params.chainHints) {
            RawJson pts = RawJson::array();
            for (const auto& v : h) pts.push(RawJson::vec3(v));
            hints.push(std::move(pts));
        }
        p.set("chainHints", std::move(hints));
    }
    root.set("params", std::move(p));
    return root;
}

/** Reads a GLB, rigs it, applies `rename`, and writes the skinned GLB (textures untouched). */
inline SbRigResult rigGlbFile(const std::string& inputPath, const std::string& outputPath, const SbRigParams& params, const RenameMap& rename = {}) {
    GlbContainer glb = GlbContainer::parse(GlbContainer::readFile(inputPath));
    SceneGeometry scene = readSceneGeometry(glb);
    SbRigResult result = SbRigSolver::solve(scene.mesh, params);
    if (!rename.empty()) result.rename(rename);
    detail::Stopwatch clock;
    GlbContainer::writeFile(outputPath, SbRigGlbPatcher::attach(std::move(glb), scene, result));
    result.report.timingsMs.push_back({"write", clock.lapMs()});
    return result;
}

}  // namespace sb_rig
}  // namespace scratchbox

#endif  // SCRATCHBOX_SB_RIG_HPP
