/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI driver of the sparse narrow-band distance field (scratchbox_sparse_field.hpp).
 *
 *   sparse_field_native run <request.bin> <result.bin>
 *       The binary request of sparse-field-native.ts: a mesh, the voxel and band, a list of closings and openings,
 *       query points and an optional path to save the field to. The result holds a JSON report, then the signed
 *       distance at each query point and whether the field knew it.
 *
 *   sparse_field_native proof --glb <scan.glb> --out <dir> [--voxel 0.05] [--band 3] [--close 0.5,1] [--open r]
 *                             [--up y] [--views 4] [--size 900] [--section 0.3] [--crop a0,a1,b0,b1] [--detail lo,hi[,az]]
 *                             [--morph-ratio 8]
 *       Builds the field of a GLB's triangles, applies each closing (and opening) to a copy, and writes per field a clay
 *       render by sphere tracing the field itself (no mesh) from each view, a horizontal section (inside grey, outside
 *       white, the zero crossing red), and report.json with the counts, memory and timings.
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_sparse_field.hpp"

#include <cstdio>
#include <iostream>
#include <sstream>
#include <thread>

using namespace scratchbox;
using sparse_field::SparseField;
using sparse_field::Vec3;

namespace {

constexpr uint32_t kReqMagic = 0x51534253u;  // "SBSQ"
constexpr uint32_t kResMagic = 0x52534253u;  // "SBSR"
constexpr uint32_t kVersion = 1;

std::string fmt(double v) { std::ostringstream o; o.precision(6); o << v; return o.str(); }

std::string buildJson(const sparse_field::BuildStats& b) {
    std::ostringstream o;
    o << "{\"inputTriangles\":" << b.inputTriangles << ",\"blocks\":" << b.blocks << ",\"activeVoxels\":" << b.activeVoxels << ",\"tiles\":" << b.tiles
      << ",\"windingEvaluations\":" << b.windingEvaluations << ",\"signGroups\":" << b.signGroups << ",\"splitGroups\":" << b.splitGroups
      << ",\"guidedGroups\":" << b.guidedGroups << ",\"guideLevels\":" << b.guideLevels
      << ",\"memoryBytes\":" << b.memoryBytes << ",\"ms\":{\"bin\":" << fmt(b.msBin) << ",\"distance\":" << fmt(b.msDistance) << ",\"sign\":" << fmt(b.msSign)
      << ",\"tiles\":" << fmt(b.msTiles) << ",\"guide\":" << fmt(b.msGuide) << "}}";
    return o.str();
}

std::string morphJson(const std::string& op, double r, const sparse_field::MorphStats& m, const SparseField& F) {
    std::ostringstream o;
    o << "{\"op\":\"" << op << "\",\"radiusM\":" << fmt(r) << ",\"seeds\":" << m.seeds << ",\"reached\":" << m.reached << ",\"blocksAdded\":" << m.blocksAdded
      << ",\"blocksPruned\":" << m.blocksPruned << ",\"rounds\":" << m.rounds << ",\"peakBlocks\":" << m.peakBlocks << ",\"peakMemoryBytes\":" << m.peakMemoryBytes
      << ",\"blocks\":" << F.blocks.size() << ",\"activeVoxels\":" << F.activeVoxels() << ",\"tiles\":" << F.tiles.size() << ",\"memoryBytes\":" << F.memoryBytes()
      << ",\"ms\":{\"dilate\":" << fmt(m.msDilate) << ",\"redistance\":" << fmt(m.msRedistance) << "}}";
    return o.str();
}

std::string coarseJson(const std::string& op, double r, const sparse_field::CoarseMorphStats& c, const SparseField& F) {
    std::ostringstream o;
    o << "{\"op\":\"" << op << "\",\"radiusM\":" << fmt(r) << ",\"coarseVoxelM\":" << fmt(c.coarseVoxel) << ",\"coarseBuild\":" << buildJson(c.coarseBuild)
      << ",\"coarse\":" << morphJson(op, r, c.coarse, F) << ",\"fineBlocksAdded\":" << c.fineBlocksAdded << ",\"fineBlocksPruned\":" << c.fineBlocksPruned
      << ",\"fineVoxelsChanged\":" << c.fineVoxelsChanged << ",\"blocks\":" << F.blocks.size() << ",\"activeVoxels\":" << F.activeVoxels() << ",\"memoryBytes\":" << F.memoryBytes()
      << ",\"ms\":{\"coarseBuild\":" << fmt(c.coarseBuild.msBin + c.coarseBuild.msDistance + c.coarseBuild.msSign + c.coarseBuild.msTiles)
      << ",\"coarseMorph\":" << fmt(c.coarse.msDilate + c.coarse.msRedistance) << ",\"merge\":" << fmt(c.msMerge) << "}}";
    return o.str();
}

/** One closing or opening: on a coarser grid merged into the field when coarseVoxel is above the field's voxel. */
std::string applyOp(SparseField& F, uint32_t kind, double r, double coarseVoxel, const sparse_field::MeshSource& src,
                    const std::vector<std::array<uint32_t, sparse_field::kVox>>* nearest, FixedThreadPool& pool, double* ms) {
    const double t0 = sparse_field::detail::now();
    const std::string op = kind == 0 ? "close" : "open";
    std::string js;
    if (coarseVoxel > F.voxel * 1.0001) {
        const auto c = sparse_field::morphCoarse(F, r, kind == 1, src, coarseVoxel, pool);
        js = coarseJson(op, r, c, F);
    } else {
        const auto m = kind == 0 ? sparse_field::close(F, r, pool, nearest ? &src : nullptr, nearest) : sparse_field::open(F, r, pool, nearest ? &src : nullptr, nearest);
        js = morphJson(op, r, m, F);
    }
    if (ms) *ms = sparse_field::detail::now() - t0;
    return js;
}

/** The coarse grid a radius is computed on: r / ratio, never finer than the field (ratio 0: the field's own grid). */
double coarseFor(double r, double voxel, double ratio) { return ratio > 0 ? std::max(voxel, r / ratio) : voxel; }

struct Reader {
    std::vector<uint8_t> buf;
    size_t at = 0;
    void need(size_t n) { if (at + n > buf.size()) throw std::runtime_error("request truncated at byte " + std::to_string(at)); }
    template <class T> T get() { need(sizeof(T)); T v; std::memcpy(&v, buf.data() + at, sizeof(T)); at += sizeof(T); return v; }
    template <class T> void arr(T* out, size_t n) { need(n * sizeof(T)); std::memcpy(out, buf.data() + at, n * sizeof(T)); at += n * sizeof(T); }
};

std::vector<uint8_t> readAll(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("cannot read " + p);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

int runRequest(const std::string& reqPath, const std::string& resPath) {
    Reader r;
    r.buf = readAll(reqPath);
    if (r.get<uint32_t>() != kReqMagic || r.get<uint32_t>() != kVersion) throw std::runtime_error("not a sparse field request (SBSQ v1)");
    const uint32_t threads = r.get<uint32_t>();
    sparse_field::BuildOptions bo;
    bo.voxel = r.get<double>();
    bo.bandVoxels = static_cast<int>(r.get<uint32_t>());
    bo.windingFarRatio = r.get<double>();
    const uint32_t V = r.get<uint32_t>();
    std::vector<float> pos(size_t(V) * 3);
    r.arr(pos.data(), pos.size());
    const uint32_t T = r.get<uint32_t>();
    std::vector<uint32_t> idx(size_t(T) * 3);
    r.arr(idx.data(), idx.size());
    const uint32_t nOps = r.get<uint32_t>();
    struct Op { uint32_t kind; double radius, coarseVoxel; };
    std::vector<Op> ops;
    for (uint32_t i = 0; i < nOps; ++i) { Op o; o.kind = r.get<uint32_t>(); o.radius = r.get<double>(); o.coarseVoxel = r.get<double>(); ops.push_back(o); }
    const uint32_t Q = r.get<uint32_t>();
    std::vector<float> q(size_t(Q) * 3);
    r.arr(q.data(), q.size());
    const uint32_t pl = r.get<uint32_t>();
    std::string fieldOut(pl, '\0');
    r.arr(fieldOut.data(), pl);

    FixedThreadPool pool(threads ? threads : std::max(1u, std::thread::hardware_concurrency()));
    const double t0 = sparse_field::detail::now();
    sparse_field::MeshSource src(sparse_field::trianglesOf(pos.data(), V, idx.data(), T), bo.windingFarRatio);
    sparse_field::BuildStats bs;
    // exact closest-point seeds are needed only when the first op runs on the field's own grid
    const bool wantNearest = !ops.empty() && !(ops[0].coarseVoxel > bo.voxel * 1.0001);
    std::vector<std::array<uint32_t, sparse_field::kVox>> nearest;
    SparseField F = sparse_field::build(src, bo, pool, &bs, wantNearest ? &nearest : nullptr);
    std::ostringstream json;
    json << "{\"ok\":true,\"voxelM\":" << fmt(F.voxel) << ",\"bandM\":" << fmt(F.band) << ",\"build\":" << buildJson(bs) << ",\"ops\":[";
    bool firstOp = true;
    for (const Op& o : ops) {
        if (o.kind > 1) throw std::runtime_error("unknown morphology op " + std::to_string(o.kind));
        if (!(o.radius > 0)) throw std::runtime_error("a morphology radius must be positive");
        // exact mesh seeds hold only while the field is still the mesh's own
        json << (firstOp ? "" : ",") << applyOp(F, o.kind, o.radius, std::max(o.coarseVoxel, F.voxel), src, firstOp && wantNearest ? &nearest : nullptr, pool, nullptr);
        firstOp = false;
    }
    json << "],\"blocks\":" << F.blocks.size() << ",\"activeVoxels\":" << F.activeVoxels() << ",\"tiles\":" << F.tiles.size() << ",\"memoryBytes\":" << F.memoryBytes();
    if (!fieldOut.empty()) { F.save(fieldOut); json << ",\"fieldPath\":\"" << fieldOut << "\""; }
    std::vector<float> vals(Q);
    std::vector<uint8_t> known(Q);
    pool.forEach(Q, [&](size_t i) {
        bool k = true;
        vals[i] = sparse_field::signedDistance(F, {q[3 * i], q[3 * i + 1], q[3 * i + 2]}, &src, &k);
        known[i] = k ? 1 : 0;
    });
    json << ",\"ms\":" << fmt(sparse_field::detail::now() - t0) << "}";
    const std::string js = json.str();
    std::ofstream f(resPath, std::ios::binary);
    const uint32_t hdr[3] = {kResMagic, kVersion, static_cast<uint32_t>(js.size())};
    f.write(reinterpret_cast<const char*>(hdr), 12);
    f.write(js.data(), static_cast<std::streamsize>(js.size()));
    f.write(reinterpret_cast<const char*>(&Q), 4);
    f.write(reinterpret_cast<const char*>(vals.data()), sizeof(float) * Q);
    f.write(reinterpret_cast<const char*>(known.data()), Q);
    if (!f) throw std::runtime_error("cannot write " + resPath);
    return 0;
}

// ---------------------------------------------------------------- proof renders

struct Box { Vec3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300}; };

/** Stored blocks grouped 8^3 to a superblock, so a ray crosses empty space a superblock at a time. */
struct Occupancy {
    std::unordered_map<uint64_t, uint8_t> super;
    explicit Occupancy(const SparseField& F) { for (const auto& b : F.blocks) super[sparse_field::blockKey(b.bx >> 3, b.by >> 3, b.bz >> 3)] = 1; }
};

double exitT(const Vec3& o, const Vec3& d, const Vec3& lo, const Vec3& hi) {
    double t = 1e300;
    for (int k = 0; k < 3; ++k) {
        if (std::fabs(d[k]) < 1e-12) continue;
        const double tk = ((d[k] > 0 ? hi[k] : lo[k]) - o[k]) / d[k];
        t = std::min(t, tk);
    }
    return std::max(t, 0.0);
}

/** Sphere traces the field along one ray; returns the hit distance or -1. */
double trace(const SparseField& F, const Occupancy& occ, const Vec3& o, const Vec3& d, double t0, double t1) {
    const double h = F.voxel, B = h * sparse_field::kDim, SB = B * 8;
    double t = t0, prevT = t0;
    float prevV = F.band;
    for (int it = 0; it < 200000 && t < t1; ++it) {
        const Vec3 p = {o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t};
        const int vx = static_cast<int>(std::floor((p[0] - F.origin[0]) / h + 0.5)), vy = static_cast<int>(std::floor((p[1] - F.origin[1]) / h + 0.5)),
                  vz = static_cast<int>(std::floor((p[2] - F.origin[2]) / h + 0.5));
        const int bx = sparse_field::blockOf(vx), by = sparse_field::blockOf(vy), bz = sparse_field::blockOf(vz);
        if (!occ.super.count(sparse_field::blockKey(bx >> 3, by >> 3, bz >> 3))) {
            const Vec3 lo = {F.origin[0] + ((bx >> 3) * 64 - 0.5) * h, F.origin[1] + ((by >> 3) * 64 - 0.5) * h, F.origin[2] + ((bz >> 3) * 64 - 0.5) * h};
            const Vec3 hi = {lo[0] + SB, lo[1] + SB, lo[2] + SB};
            t += exitT(p, d, lo, hi) + 1e-4;
            prevV = F.band; prevT = t;
            continue;
        }
        if (F.find(bx, by, bz) < 0) {
            if (F.tileSign(bx, by, bz) < 0) return t;  // entered an inside tile without crossing a band: call it the surface
            const Vec3 lo = {F.origin[0] + (bx * 8 - 0.5) * h, F.origin[1] + (by * 8 - 0.5) * h, F.origin[2] + (bz * 8 - 0.5) * h};
            const Vec3 hi = {lo[0] + B, lo[1] + B, lo[2] + B};
            t += exitT(p, d, lo, hi) + 1e-4;
            prevV = F.band; prevT = t;
            continue;
        }
        const float v = F.sample(p);
        if (v < 0) {
            // bisect between the last positive sample and this one
            double a = prevT, b = t;
            for (int k = 0; k < 12; ++k) {
                const double m = 0.5 * (a + b);
                const Vec3 pm = {o[0] + d[0] * m, o[1] + d[1] * m, o[2] + d[2] * m};
                (F.sample(pm) < 0 ? b : a) = m;
            }
            (void)prevV;
            return 0.5 * (a + b);
        }
        prevV = v; prevT = t;
        t += std::max(static_cast<double>(v) * 0.9, h * 0.25);
    }
    return -1;
}

void putPng(const std::string& path, const texture::ImageBuffer& img) {
    const auto bytes = png::encode(img);
    std::ofstream f(path, std::ios::binary);
    f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}

/** Clay render of the field from azimuth az (degrees), elevation el, framing the box. `up` is the up axis (0..2). */
texture::ImageBuffer renderClay(const SparseField& F, const Occupancy& occ, const Box& box, int up, double az, double el, int W, int H, FixedThreadPool& pool) {
    const int a0 = (up + 1) % 3, a1 = (up + 2) % 3;
    Vec3 c, ext;
    for (int k = 0; k < 3; ++k) { c[k] = 0.5 * (box.lo[k] + box.hi[k]); ext[k] = box.hi[k] - box.lo[k]; }
    const double radius = 0.5 * std::sqrt(ext[0] * ext[0] + ext[1] * ext[1] + ext[2] * ext[2]);
    const double A = az * M_PI / 180, E = el * M_PI / 180;
    Vec3 fwd{0, 0, 0};
    fwd[a0] = -std::cos(E) * std::cos(A); fwd[a1] = -std::cos(E) * std::sin(A); fwd[up] = -std::sin(E);
    Vec3 upv{0, 0, 0};
    upv[up] = 1;
    Vec3 right = inner_core::cross(fwd, upv);
    right = inner_core::mul(right, 1.0 / inner_core::len(right));
    const Vec3 camUp = inner_core::cross(right, fwd);
    const double fov = 30 * M_PI / 180, dist = radius / std::sin(fov * 0.5) * 1.02;
    const Vec3 eye = inner_core::sub(c, inner_core::mul(fwd, dist));
    Vec3 light{0, 0, 0};
    light[a0] = 0.45; light[a1] = 0.35; light[up] = 0.82;
    light = inner_core::mul(light, 1.0 / inner_core::len(light));
    texture::ImageBuffer img(W, H, 3, 255);
    const double tanH = std::tan(fov * 0.5), aspect = static_cast<double>(W) / H;
    pool.forEach(static_cast<size_t>(H), [&](size_t yy) {
        const int y = static_cast<int>(yy);
        for (int x = 0; x < W; ++x) {
            const double sx = (2 * (x + 0.5) / W - 1) * tanH * aspect, sy = (1 - 2 * (y + 0.5) / H) * tanH;
            Vec3 d = inner_core::add(fwd, inner_core::add(inner_core::mul(right, sx), inner_core::mul(camUp, sy)));
            d = inner_core::mul(d, 1.0 / inner_core::len(d));
            // clip the ray to the box
            double t0 = 0, t1 = 1e300;
            bool miss = false;
            for (int k = 0; k < 3; ++k) {
                if (std::fabs(d[k]) < 1e-12) { if (eye[k] < box.lo[k] || eye[k] > box.hi[k]) miss = true; continue; }
                double ta = (box.lo[k] - eye[k]) / d[k], tb = (box.hi[k] - eye[k]) / d[k];
                if (ta > tb) std::swap(ta, tb);
                t0 = std::max(t0, ta); t1 = std::min(t1, tb);
            }
            uint8_t* px = &img.data[(static_cast<size_t>(y) * W + x) * 3];
            const double g = 0.93 + 0.05 * (1 - static_cast<double>(y) / H);
            px[0] = px[1] = px[2] = static_cast<uint8_t>(255 * g);
            if (miss || t0 > t1) continue;
            const double t = trace(F, occ, eye, d, t0, t1);
            if (t < 0) continue;
            const Vec3 p = inner_core::add(eye, inner_core::mul(d, t));
            const double e = F.voxel;
            Vec3 n;
            for (int k = 0; k < 3; ++k) {
                Vec3 pp = p, pm = p;
                pp[k] += e; pm[k] -= e;
                n[k] = F.sample(pp) - F.sample(pm);
            }
            const double nl = inner_core::len(n);
            if (nl > 0) n = inner_core::mul(n, 1.0 / nl); else n = inner_core::mul(d, -1);
            if (inner_core::dot(n, d) > 0) n = inner_core::mul(n, -1);
            const double lam = std::max(0.0, inner_core::dot(n, light));
            const double sky = 0.5 + 0.5 * n[up];
            const double shade = std::clamp(0.16 + 0.62 * lam + 0.22 * sky, 0.0, 1.0);
            px[0] = static_cast<uint8_t>(std::clamp(shade * 236, 0.0, 255.0));
            px[1] = static_cast<uint8_t>(std::clamp(shade * 226, 0.0, 255.0));
            px[2] = static_cast<uint8_t>(std::clamp(shade * 212, 0.0, 255.0));
        }
    });
    return img;
}

/** A horizontal section at height `level` (world units along `up`): inside grey, outside white, the zero crossing red. */
texture::ImageBuffer renderSection(const SparseField& F, const sparse_field::MeshSource& src, const Box& box, int up, double level, int W, FixedThreadPool& pool) {
    const int a0 = (up + 1) % 3, a1 = (up + 2) % 3;
    const double sx = box.hi[a0] - box.lo[a0], sz = box.hi[a1] - box.lo[a1];
    const int H = std::max(1, static_cast<int>(W * sz / sx));
    const double px = sx / W;
    texture::ImageBuffer img(W, H, 3, 255);
    std::mutex m;
    std::unordered_map<uint64_t, int8_t> farSign;
    pool.forEach(static_cast<size_t>(H), [&](size_t yy) {
        for (int x = 0; x < W; ++x) {
            Vec3 p;
            p[a0] = box.lo[a0] + (x + 0.5) * px;
            p[a1] = box.hi[a1] - (yy + 0.5) * px;
            p[up] = level;
            bool known = true;
            float v = F.sample(p, &known);
            if (!known) {
                const int bx = sparse_field::blockOf(static_cast<int>(std::lround((p[0] - F.origin[0]) / F.voxel))),
                          by = sparse_field::blockOf(static_cast<int>(std::lround((p[1] - F.origin[1]) / F.voxel))),
                          bz = sparse_field::blockOf(static_cast<int>(std::lround((p[2] - F.origin[2]) / F.voxel)));
                const int ts = F.tileSign(bx, by, bz);
                if (F.find(bx, by, bz) >= 0) v = F.at(static_cast<int>(std::lround((p[0] - F.origin[0]) / F.voxel)), static_cast<int>(std::lround((p[1] - F.origin[1]) / F.voxel)), static_cast<int>(std::lround((p[2] - F.origin[2]) / F.voxel)));
                else if (ts) v = ts * F.band;
                else {
                    const uint64_t k = sparse_field::blockKey(bx, by, bz);
                    int8_t s;
                    {
                        std::lock_guard<std::mutex> g(m);
                        auto it = farSign.find(k);
                        s = it == farSign.end() ? 0 : it->second;
                    }
                    if (!s) {
                        s = src.inside(F.centre(bx * 8 + 4, by * 8 + 4, bz * 8 + 4)) ? -1 : 1;
                        std::lock_guard<std::mutex> g(m);
                        farSign[k] = s;
                    }
                    v = s * F.band;
                }
            }
            uint8_t* q = &img.data[(yy * W + x) * 3];
            if (std::fabs(v) < 0.6 * std::max(px, F.voxel)) { q[0] = 214; q[1] = 40; q[2] = 40; }
            else if (v < 0) { q[0] = 92; q[1] = 96; q[2] = 104; }
            else if (v < F.band) { q[0] = 222; q[1] = 230; q[2] = 240; }  // the outside band
            else { q[0] = q[1] = q[2] = 250; }
        }
    });
    return img;
}

std::vector<double> parseList(const std::string& s) {
    std::vector<double> out;
    std::stringstream ss(s);
    std::string t;
    while (std::getline(ss, t, ',')) if (!t.empty()) out.push_back(std::stod(t));
    return out;
}

int runProof(int argc, char** argv) {
    std::string glb, out;
    double voxel = 0.05, sectionFrac = 0.3;
    int band = 3, up = 1, views = 4, size = 900;
    std::vector<double> closes = {0.5, 1.0}, opens, crop, detail;
    double ratio = 8;
    for (int i = 2; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { if (i + 1 >= argc) throw std::runtime_error(a + " needs a value"); return argv[++i]; };
        if (a == "--glb") glb = next();
        else if (a == "--out") out = next();
        else if (a == "--voxel") voxel = std::stod(next());
        else if (a == "--band") band = std::stoi(next());
        else if (a == "--close") closes = parseList(next());
        else if (a == "--open") opens = parseList(next());
        else if (a == "--up") { const std::string u = next(); up = u == "x" ? 0 : u == "z" ? 2 : 1; }
        else if (a == "--views") views = std::stoi(next());
        else if (a == "--size") size = std::stoi(next());
        else if (a == "--section") sectionFrac = std::stod(next());
        else if (a == "--crop") crop = parseList(next());
        else if (a == "--detail") detail = parseList(next());
        else if (a == "--morph-ratio") ratio = std::stod(next());
        else throw std::runtime_error("unknown option " + a);
    }
    if (glb.empty() || out.empty()) throw std::runtime_error("proof needs --glb and --out");
    FixedThreadPool pool(std::max(1u, std::thread::hardware_concurrency()));
    const double tl = sparse_field::detail::now();
    auto scene = gltf::GlbSceneReader::readFile(glb);
    std::vector<float> pos;
    pos.reserve(scene.mesh.vertices.size() * 3);
    for (const auto& v : scene.mesh.vertices) { pos.push_back(v.position.x); pos.push_back(v.position.y); pos.push_back(v.position.z); }
    // --crop a0min,a0max,a1min,a1max: keep the triangles whose centroid lies in that box across the two horizontal axes
    std::vector<uint32_t> idx;
    const int h0 = (up + 1) % 3, h1 = (up + 2) % 3;
    for (size_t t = 0; t + 2 < scene.mesh.indices.size(); t += 3) {
        const uint32_t* tr = &scene.mesh.indices[t];
        if (crop.size() == 4) {
            const double c0 = (pos[3 * tr[0] + h0] + pos[3 * tr[1] + h0] + pos[3 * tr[2] + h0]) / 3, c1 = (pos[3 * tr[0] + h1] + pos[3 * tr[1] + h1] + pos[3 * tr[2] + h1]) / 3;
            if (c0 < crop[0] || c0 > crop[1] || c1 < crop[2] || c1 > crop[3]) continue;
        }
        idx.insert(idx.end(), tr, tr + 3);
    }
    Box box;
    for (uint32_t v : idx) for (int k = 0; k < 3; ++k) { box.lo[k] = std::min<double>(box.lo[k], pos[3 * v + k]); box.hi[k] = std::max<double>(box.hi[k], pos[3 * v + k]); }
    sparse_field::MeshSource src(sparse_field::trianglesOf(pos.data(), scene.mesh.vertices.size(), idx.data(), idx.size() / 3));
    std::vector<float>().swap(pos);
    const double msLoad = sparse_field::detail::now() - tl;
    std::cerr << "loaded " << idx.size() / 3 << " triangles in " << msLoad << " ms; box " << box.lo[0] << "," << box.lo[1] << "," << box.lo[2] << " .. " << box.hi[0] << "," << box.hi[1] << "," << box.hi[2] << "\n";
    // scan surface area (for voxels per square metre)
    double area = 0;
    for (const auto& t : src.tris) area += 0.5 * inner_core::len(inner_core::cross(inner_core::sub(t.b, t.a), inner_core::sub(t.c, t.a)));

    sparse_field::BuildOptions bo;
    bo.voxel = voxel;
    bo.bandVoxels = band;
    sparse_field::BuildStats bs;
    bool anyDirect = false;
    for (double r : closes) anyDirect = anyDirect || coarseFor(r, voxel, ratio) <= voxel * 1.0001;
    for (double r : opens) anyDirect = anyDirect || coarseFor(r, voxel, ratio) <= voxel * 1.0001;
    std::vector<std::array<uint32_t, sparse_field::kVox>> nearest;
    const double tb = sparse_field::detail::now();
    SparseField base = sparse_field::build(src, bo, pool, &bs, anyDirect ? &nearest : nullptr);
    const double msBuild = sparse_field::detail::now() - tb;
    std::cerr << "built " << base.blocks.size() << " blocks, " << bs.activeVoxels << " active voxels in " << msBuild << " ms\n";

    std::ostringstream js;
    js << "{\"glb\":\"" << glb << "\",\"triangles\":" << src.tris.size() << ",\"surfaceAreaM2\":" << fmt(area) << ",\"voxelM\":" << fmt(voxel) << ",\"bandVoxels\":" << band
       << ",\"box\":[[" << box.lo[0] << "," << box.lo[1] << "," << box.lo[2] << "],[" << box.hi[0] << "," << box.hi[1] << "," << box.hi[2] << "]]"
       << ",\"crop\":" << (crop.size() == 4 ? "[" + fmt(crop[0]) + "," + fmt(crop[1]) + "," + fmt(crop[2]) + "," + fmt(crop[3]) + "]" : std::string("null")) << ",\"morphRatio\":" << fmt(ratio)
       << ",\"msLoad\":" << fmt(msLoad) << ",\"msBuild\":" << fmt(msBuild) << ",\"build\":" << buildJson(bs) << ",\"fields\":[";

    // pad the render box by the largest radius so a closing's growth stays in frame
    double maxR = 0;
    for (double r : closes) maxR = std::max(maxR, r);
    Box rbox = box;
    for (int k = 0; k < 3; ++k) { rbox.lo[k] -= maxR + base.band; rbox.hi[k] += maxR + base.band; }
    const double level = box.lo[up] + sectionFrac * (box.hi[up] - box.lo[up]);

    auto emit = [&](const std::string& name, const SparseField& F, const std::string& extra, bool firstField) {
        const double tr = sparse_field::detail::now();
        Occupancy occ(F);
        for (int v = 0; v < views; ++v) {
            const auto img = renderClay(F, occ, rbox, up, 45.0 + v * 360.0 / views, 18.0, size * 3 / 4, size, pool);
            putPng(out + "/" + name + "_view" + std::to_string(v) + ".png", img);
        }
        // --detail lo,hi[,az]: a close-up of the band of heights lo..hi (world units along up), the box's plan kept
        if (detail.size() >= 2) {
            Box dbox = rbox;
            dbox.lo[up] = detail[0]; dbox.hi[up] = detail[1];
            const double az = detail.size() >= 3 ? detail[2] : 45.0;
            putPng(out + "/" + name + "_detail.png", renderClay(F, occ, dbox, up, az, 22.0, size * 4 / 3, size, pool));
        }
        putPng(out + "/" + name + "_section.png", renderSection(F, src, rbox, up, level, size, pool));
        js << (firstField ? "" : ",") << "{\"name\":\"" << name << "\",\"blocks\":" << F.blocks.size() << ",\"activeVoxels\":" << F.activeVoxels() << ",\"tiles\":" << F.tiles.size()
           << ",\"memoryBytes\":" << F.memoryBytes() << (extra.empty() ? "" : ",\"morph\":" + extra) << ",\"msRender\":" << fmt(sparse_field::detail::now() - tr) << "}";
        std::cerr << name << " rendered\n";
    };
    emit("scan", base, "", true);
    for (int kind = 0; kind < 2; ++kind)
        for (double r : kind == 0 ? closes : opens) {
            SparseField F = base;
            double ms = 0;
            const std::string j = applyOp(F, static_cast<uint32_t>(kind), r, coarseFor(r, voxel, ratio), src, anyDirect ? &nearest : nullptr, pool, &ms);
            std::cerr << (kind ? "opened" : "closed") << " r=" << r << " in " << ms << " ms\n";
            emit(std::string(kind ? "open_" : "close_") + fmt(r), F, j.substr(0, j.size() - 1) + ",\"msTotal\":" + fmt(ms) + "}", false);
        }
    js << "],\"sectionLevel\":" << fmt(level) << "}";
    std::ofstream(out + "/report.json") << js.str() << "\n";
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc >= 4 && std::string(argv[1]) == "run") return runRequest(argv[2], argv[3]);
        if (argc >= 2 && std::string(argv[1]) == "proof") return runProof(argc, argv);
        std::cerr << "usage: sparse_field_native run <request.bin> <result.bin>\n       sparse_field_native proof --glb <scan.glb> --out <dir> [options]\n";
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "sparse_field_native: " << e.what() << "\n";
        return 1;
    }
}
