/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Rig pipeline runner (C++20): rigs any GLB with a geometry-derived skeleton and
 * geodesic skin weights, preserving every texture and material of the source file.
 *
 *   run_sb_rig_pipeline --input in.glb --output out.glb [--report out.sbrig.json]
 *       [--param-<name> <value>]... [--root-hint x,y,z] [--chain-hint "x,y,z;x,y,z;..."]...
 *       [--rename Chain3=LeftIndex]...
 *
 *   Synthetic test shapes (SDF unions meshed with surface nets, written as a plain GLB, then
 *   rigged through the same path):
 *       --synthetic claw|tree --synthetic-out shape.glb [--synthetic-truth truth.json]
 *       [--digits N] [--spread-deg D] [--curled K] [--scale S] [--mc-res R]
 ********************************************************************************/

#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_sb_rig.hpp"

#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using scratchbox::math::AABB;
using scratchbox::math::Vec3;
using scratchbox::sb_rig::RawJson;

namespace {

Vec3 parseVec3(const std::string& text) {
    std::stringstream ss(text);
    std::string part;
    float v[3];
    int i = 0;
    while (std::getline(ss, part, ',')) {
        if (i >= 3) throw std::invalid_argument("expected x,y,z but got '" + text + "'");
        v[i++] = std::stof(part);
    }
    if (i != 3) throw std::invalid_argument("expected x,y,z but got '" + text + "'");
    return Vec3(v[0], v[1], v[2]);
}

std::vector<Vec3> parsePolyline(const std::string& text) {
    std::vector<Vec3> pts;
    std::stringstream ss(text);
    std::string point;
    while (std::getline(ss, point, ';')) {
        if (!point.empty()) pts.push_back(parseVec3(point));
    }
    return pts;
}

// ---------------------------------------------------------------------------
// Synthetic shapes: signed-distance unions polygonised by marching cubes
// ---------------------------------------------------------------------------

struct Capsule {
    Vec3 a, b;
    float r;
};

struct Ellipsoid {
    Vec3 c, r;
};

struct SyntheticShape {
    std::vector<Capsule> capsules;
    std::vector<Ellipsoid> ellipsoids;
    RawJson truth = RawJson::object();
};

float sdCapsule(const Vec3& p, const Capsule& c) {
    Vec3 pa = p - c.a, ba = c.b - c.a;
    float h = std::clamp(pa.dot(ba) / ba.dot(ba), 0.0f, 1.0f);
    return (pa - ba * h).length() - c.r;
}

float sdEllipsoid(const Vec3& p, const Ellipsoid& e) {
    Vec3 q = p - e.c;
    float k0 = Vec3(q.x / e.r.x, q.y / e.r.y, q.z / e.r.z).length();
    float k1 = Vec3(q.x / (e.r.x * e.r.x), q.y / (e.r.y * e.r.y), q.z / (e.r.z * e.r.z)).length();
    return k1 > 0.0f ? k0 * (k0 - 1.0f) / k1 : -std::min({e.r.x, e.r.y, e.r.z});
}

float smoothMin(float a, float b, float k) {
    float h = std::max(k - std::fabs(a - b), 0.0f) / k;
    return std::min(a, b) - h * h * k * 0.25f;
}

float evaluate(const SyntheticShape& s, const Vec3& p) {
    float d = 1e9f;
    for (const auto& e : s.ellipsoids) d = smoothMin(d, sdEllipsoid(p, e), 0.12f);
    for (const auto& c : s.capsules) d = smoothMin(d, sdCapsule(p, c), 0.12f);
    return d;
}

RawJson vec(const Vec3& v) { return RawJson::vec3(v); }

SyntheticShape buildClaw(int digits, float spreadDeg, int curled) {
    SyntheticShape s;
    Ellipsoid palm{Vec3(0, 0, 0), Vec3(1.0f, 0.8f, 0.5f)};
    s.ellipsoids.push_back(palm);
    s.capsules.push_back({Vec3(0, -0.5f, 0), Vec3(0, -2.8f, 0), 0.42f});
    s.truth.set("kind", RawJson::string("claw"));
    s.truth.set("stalkBottom", vec(Vec3(0, -2.8f - 0.42f, 0)));

    RawJson digitList = RawJson::array();
    const float xShift = curled > 0 ? 0.3f : 0.0f;
    const float spread = (curled > 0 ? std::min(spreadDeg, 40.0f) : spreadDeg) * static_cast<float>(M_PI) / 180.0f;
    for (int i = 0; i < digits; ++i) {
        float theta = digits == 1 ? 0.0f : spread * (static_cast<float>(i) / static_cast<float>(digits - 1) - 0.5f);
        Vec3 d(std::sin(theta), std::cos(theta), 0.0f);
        Vec3 base = Vec3(xShift, 0.45f, 0.0f) + d * 0.35f;
        Vec3 tip = base + d * 2.2f;
        s.capsules.push_back({base, tip, 0.22f});
        RawJson dj = RawJson::object();
        dj.set("base", vec(base));
        dj.set("tip", vec(tip));
        dj.set("radius", RawJson::number(0.22));
        dj.set("curled", RawJson::boolean(false));
        digitList.push(std::move(dj));
    }

    for (int k = 0; k < curled; ++k) {
        const float xc = -0.55f + 0.4f * static_cast<float>(k);
        const Vec3 centre(xc, 0.45f, 0.35f);
        const float radius = 0.7f, endPhi = 1.4f * static_cast<float>(M_PI);
        auto arc = [&](float phi) { return Vec3(xc, centre.y + radius * std::sin(phi), centre.z - radius * std::cos(phi)); };
        const int steps = 28;
        for (int i = 0; i < steps; ++i) {
            float a = endPhi * static_cast<float>(i) / steps, b = endPhi * static_cast<float>(i + 1) / steps;
            s.capsules.push_back({arc(a), arc(b), 0.2f});
        }
        float emergePhi = 0.0f;
        for (int i = 0; i <= 200; ++i) {
            float phi = endPhi * static_cast<float>(i) / 200.0f;
            if (sdEllipsoid(arc(phi), palm) > 0.0f) {
                emergePhi = phi;
                break;
            }
        }
        RawJson dj = RawJson::object();
        dj.set("base", vec(arc(emergePhi)));
        dj.set("apex", vec(arc(0.75f * static_cast<float>(M_PI))));
        dj.set("tip", vec(arc(endPhi)));
        dj.set("radius", RawJson::number(0.2));
        dj.set("curled", RawJson::boolean(true));
        digitList.push(std::move(dj));
    }
    s.truth.set("digits", std::move(digitList));
    return s;
}

SyntheticShape buildTree() {
    SyntheticShape s;
    s.capsules.push_back({Vec3(0, -3.0f, 0), Vec3(0, 0, 0), 0.4f});
    RawJson leaves = RawJson::array();
    RawJson branchPoints = RawJson::array();
    branchPoints.push(vec(Vec3(0, 0, 0)));
    for (float side : {-1.0f, 1.0f}) {
        Vec3 fork(side * 1.3f, 1.7f, 0);
        s.capsules.push_back({Vec3(0, 0, 0), fork, 0.3f});
        branchPoints.push(vec(fork));
        for (float sub : {-1.0f, 1.0f}) {
            Vec3 leaf = fork + Vec3(sub * 0.85f, 1.5f, 0);
            s.capsules.push_back({fork, leaf, 0.2f});
            leaves.push(vec(leaf));
        }
    }
    s.truth.set("kind", RawJson::string("tree"));
    s.truth.set("trunkBottom", vec(Vec3(0, -3.4f, 0)));
    s.truth.set("branchPoints", std::move(branchPoints));
    s.truth.set("leaves", std::move(leaves));
    return s;
}

AABB shapeBounds(const SyntheticShape& s) {
    Vec3 lo(1e9f, 1e9f, 1e9f), hi(-1e9f, -1e9f, -1e9f);
    auto grow = [&](const Vec3& p, float r) {
        lo = Vec3(std::min(lo.x, p.x - r), std::min(lo.y, p.y - r), std::min(lo.z, p.z - r));
        hi = Vec3(std::max(hi.x, p.x + r), std::max(hi.y, p.y + r), std::max(hi.z, p.z + r));
    };
    for (const auto& c : s.capsules) {
        grow(c.a, c.r);
        grow(c.b, c.r);
    }
    for (const auto& e : s.ellipsoids) grow(e.c, std::max({e.r.x, e.r.y, e.r.z}));
    AABB box;
    box.min = lo - Vec3(0.25f, 0.25f, 0.25f);
    box.max = hi + Vec3(0.25f, 0.25f, 0.25f);
    return box;
}

/** Naive surface nets: one vertex per sign-changing cell, one quad per sign-changing grid edge (watertight). */
scratchbox::geometry::ScratchboxMesh surfaceNets(const std::function<float(const Vec3&)>& field, const AABB& box, int res) {
    const int n = res + 1;
    const Vec3 step = (box.max - box.min) * (1.0f / static_cast<float>(res));
    auto at = [&](int i, int j, int k) { return box.min + Vec3(i * step.x, j * step.y, k * step.z); };
    std::vector<float> s(static_cast<size_t>(n) * n * n);
    auto sid = [&](int i, int j, int k) { return (static_cast<size_t>(k) * n + j) * n + i; };
    for (int k = 0; k < n; ++k)
        for (int j = 0; j < n; ++j)
            for (int i = 0; i < n; ++i) s[sid(i, j, k)] = field(at(i, j, k));

    scratchbox::geometry::ScratchboxMesh mesh("sbrig_surface_nets");
    std::vector<int32_t> cellVertex(static_cast<size_t>(res) * res * res, -1);
    auto cid = [&](int i, int j, int k) { return (static_cast<size_t>(k) * res + j) * res + i; };
    static const int corner[8][3] = {{0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {1, 1, 0}, {0, 0, 1}, {1, 0, 1}, {0, 1, 1}, {1, 1, 1}};
    static const int edges[12][2] = {{0, 1}, {2, 3}, {4, 5}, {6, 7}, {0, 2}, {1, 3}, {4, 6}, {5, 7}, {0, 4}, {1, 5}, {2, 6}, {3, 7}};
    for (int k = 0; k < res; ++k) {
        for (int j = 0; j < res; ++j) {
            for (int i = 0; i < res; ++i) {
                float v[8];
                bool anyIn = false, anyOut = false;
                for (int c = 0; c < 8; ++c) {
                    v[c] = s[sid(i + corner[c][0], j + corner[c][1], k + corner[c][2])];
                    (v[c] < 0.0f ? anyIn : anyOut) = true;
                }
                if (!anyIn || !anyOut) continue;
                Vec3 sum(0, 0, 0);
                int crossings = 0;
                for (const auto& e : edges) {
                    float a = v[e[0]], b = v[e[1]];
                    if ((a < 0.0f) == (b < 0.0f)) continue;
                    float t = a / (a - b);
                    Vec3 pa = at(i + corner[e[0]][0], j + corner[e[0]][1], k + corner[e[0]][2]);
                    Vec3 pb = at(i + corner[e[1]][0], j + corner[e[1]][1], k + corner[e[1]][2]);
                    sum += pa + (pb - pa) * t;
                    ++crossings;
                }
                cellVertex[cid(i, j, k)] = static_cast<int32_t>(mesh.vertices.size());
                mesh.addVertex(scratchbox::geometry::Vertex(sum * (1.0f / static_cast<float>(crossings))));
            }
        }
    }
    auto quad = [&](int32_t a, int32_t b, int32_t c, int32_t d, bool flip) {
        if (a < 0 || b < 0 || c < 0 || d < 0) return;
        if (flip) std::swap(b, d);
        mesh.addTriangle(static_cast<uint32_t>(a), static_cast<uint32_t>(b), static_cast<uint32_t>(c));
        mesh.addTriangle(static_cast<uint32_t>(a), static_cast<uint32_t>(c), static_cast<uint32_t>(d));
    };
    for (int k = 1; k < res; ++k) {
        for (int j = 1; j < res; ++j) {
            for (int i = 0; i < res; ++i) {
                bool in = s[sid(i, j, k)] < 0.0f;
                if (in == (s[sid(i + 1, j, k)] < 0.0f)) continue;
                quad(cellVertex[cid(i, j - 1, k - 1)], cellVertex[cid(i, j, k - 1)], cellVertex[cid(i, j, k)], cellVertex[cid(i, j - 1, k)], !in);
            }
        }
    }
    for (int k = 1; k < res; ++k) {
        for (int j = 0; j < res; ++j) {
            for (int i = 1; i < res; ++i) {
                bool in = s[sid(i, j, k)] < 0.0f;
                if (in == (s[sid(i, j + 1, k)] < 0.0f)) continue;
                quad(cellVertex[cid(i - 1, j, k - 1)], cellVertex[cid(i - 1, j, k)], cellVertex[cid(i, j, k)], cellVertex[cid(i, j, k - 1)], !in);
            }
        }
    }
    for (int k = 0; k < res; ++k) {
        for (int j = 1; j < res; ++j) {
            for (int i = 1; i < res; ++i) {
                bool in = s[sid(i, j, k)] < 0.0f;
                if (in == (s[sid(i, j, k + 1)] < 0.0f)) continue;
                quad(cellVertex[cid(i - 1, j - 1, k)], cellVertex[cid(i, j - 1, k)], cellVertex[cid(i, j, k)], cellVertex[cid(i - 1, j, k)], !in);
            }
        }
    }
    mesh.recomputeNormals();
    return mesh;
}

void scaleTruth(RawJson& j, float scale) {
    if (j.kind == RawJson::Array && j.arr.size() == 3 && j.arr[0].kind == RawJson::Number) {
        for (auto& c : j.arr) c = RawJson::number(c.asNumber() * scale);
        return;
    }
    for (auto& a : j.arr) scaleTruth(a, scale);
    for (auto& kv : j.obj) {
        if (kv.first == "radius") kv.second = RawJson::number(kv.second.asNumber() * scale);
        else scaleTruth(kv.second, scale);
    }
}

void writeText(const std::string& path, const std::string& text) {
    if (fs::path(path).has_parent_path()) fs::create_directories(fs::path(path).parent_path());
    std::ofstream f(path);
    if (!f.is_open()) throw std::runtime_error("cannot write " + path);
    f << text;
}

std::string defaultReportPath(const std::string& output) {
    fs::path p(output);
    p.replace_extension("");
    return p.string() + ".sbrig.json";
}

}  // namespace

int main(int argc, char** argv) {
    std::string inputPath, outputPath, reportPath;
    std::string synthetic, syntheticOut, syntheticTruth;
    int digits = 5, curled = 0, mcRes = 112;
    bool debugTree = false;
    float spreadDeg = 70.0f, scale = 1.0f;
    scratchbox::sb_rig::SbRigParams params;
    scratchbox::sb_rig::RenameMap rename;

    try {
        for (int i = 1; i < argc; ++i) {
            std::string arg = argv[i];
            std::string inlineValue;
            bool hasInline = false;
            if (arg.rfind("--", 0) == 0 && arg.find('=') != std::string::npos) {
                inlineValue = arg.substr(arg.find('=') + 1);
                arg = arg.substr(0, arg.find('='));
                hasInline = true;
            }
            auto next = [&]() -> std::string {
                if (hasInline) return inlineValue;
                if (i + 1 >= argc) throw std::invalid_argument(arg + " needs a value");
                return argv[++i];
            };
            if (arg == "--input") inputPath = next();
            else if (arg == "--output") outputPath = next();
            else if (arg == "--report") reportPath = next();
            else if (arg == "--debug-tree") debugTree = true;
            else if (arg == "--root-hint") {
                params.rootHint = parseVec3(next());
                params.hasRootHint = true;
            } else if (arg == "--chain-hint") params.chainHints.push_back(parsePolyline(next()));
            else if (arg == "--rename") {
                std::string pair = next();
                size_t eq = pair.find('=');
                if (eq == std::string::npos || eq == 0 || eq + 1 == pair.size()) throw std::invalid_argument("--rename expects FROM=TO, got '" + pair + "'");
                rename.emplace_back(pair.substr(0, eq), pair.substr(eq + 1));
            } else if (arg.rfind("--param-", 0) == 0) params.set(arg.substr(8), next());
            else if (arg == "--synthetic") synthetic = next();
            else if (arg == "--synthetic-out") syntheticOut = next();
            else if (arg == "--synthetic-truth") syntheticTruth = next();
            else if (arg == "--digits") digits = std::stoi(next());
            else if (arg == "--curled") curled = std::stoi(next());
            else if (arg == "--spread-deg") spreadDeg = std::stof(next());
            else if (arg == "--scale") scale = std::stof(next());
            else if (arg == "--mc-res") mcRes = std::stoi(next());
            else throw std::invalid_argument("unknown argument '" + arg + "'");
        }
        if (outputPath.empty()) throw std::invalid_argument("--output is required");
        if (reportPath.empty()) reportPath = defaultReportPath(outputPath);

        if (!synthetic.empty()) {
            if (syntheticOut.empty()) throw std::invalid_argument("--synthetic needs --synthetic-out");
            if (!(scale > 0.0f)) throw std::invalid_argument("--scale must be positive");
            SyntheticShape shape;
            if (synthetic == "claw") {
                if (digits < 1 || curled < 0 || curled > 2) throw std::invalid_argument("claw needs --digits >= 1 and 0 <= --curled <= 2");
                shape = buildClaw(digits, spreadDeg, curled);
            } else if (synthetic == "tree") {
                shape = buildTree();
            } else {
                throw std::invalid_argument("unknown synthetic shape '" + synthetic + "' (claw, tree)");
            }
            AABB unit = shapeBounds(shape);
            AABB scaled;
            scaled.min = unit.min * scale;
            scaled.max = unit.max * scale;
            auto field = [&](const Vec3& p) { return evaluate(shape, p * (1.0f / scale)) * scale; };
            scratchbox::geometry::ScratchboxMesh mesh = surfaceNets(field, scaled, mcRes);
            mesh.name = "sbrig_synthetic_" + synthetic;
            if (fs::path(syntheticOut).has_parent_path()) fs::create_directories(fs::path(syntheticOut).parent_path());
            scratchbox::sb_rig::GlbContainer::writeFile(syntheticOut, scratchbox::io::GlbWriter::writeGlb(mesh));
            if (!syntheticTruth.empty()) {
                scaleTruth(shape.truth, scale);
                shape.truth.set("scale", RawJson::number(scale));
                writeText(syntheticTruth, shape.truth.dump());
            }
            inputPath = syntheticOut;
        }
        if (inputPath.empty()) throw std::invalid_argument("--input (or --synthetic) is required");

        auto start = std::chrono::steady_clock::now();
        if (fs::path(outputPath).has_parent_path()) fs::create_directories(fs::path(outputPath).parent_path());
        scratchbox::sb_rig::SbRigResult result = scratchbox::sb_rig::rigGlbFile(inputPath, outputPath, params, rename);
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        writeText(reportPath, scratchbox::sb_rig::reportJson(result, params, debugTree).dump());

        const auto& rep = result.report;
        std::cout << "[TELEMETRY] status=success"
                  << " inputVertices=" << rep.inputVertices
                  << " weldedVertices=" << rep.weldedVertices
                  << " components=" << rep.components
                  << " joints=" << result.skeleton.joints.size()
                  << " chains=" << result.chains.size()
                  << " leafChains=" << result.leafCount()
                  << " loopsCut=" << rep.loopsCut
                  << " rootSource=" << rep.rootSource
                  << " processingTimeMs=" << ms
                  << " output=" << outputPath
                  << " report=" << reportPath
                  << "\n" << std::flush;
        return 0;
    } catch (const std::invalid_argument& e) {
        std::cerr << "SB-Rig: " << e.what() << "\n";
        std::cout << "[TELEMETRY] status=error kind=invalid-input message=" << RawJson::quote(e.what()) << "\n" << std::flush;
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "SB-Rig: " << e.what() << "\n";
        std::cout << "[TELEMETRY] status=error kind=internal message=" << RawJson::quote(e.what()) << "\n" << std::flush;
        return 1;
    }
}
