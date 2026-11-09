/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI driver of dual contouring (scratchbox_dual_contour.hpp) on a sparse field (scratchbox_sparse_field.hpp).
 *
 *   dual_contour_native run <request.bin> <result.bin>
 *       The binary request of dual-contour-native.ts: a saved field (SBSF), optionally the source mesh for sharp
 *       normals, and the options. The result holds a JSON report, then the vertices, quads and triangles.
 *
 *   dual_contour_native proof --glb <scan.glb> --out <dir> [--voxel 0.05] [--close 1] [--crop a0,a1,b0,b1] [--up y]
 *                             [--detail lo,hi[,az]] [--size 900] [--simplify 0.02] [--mt-voxel 0.1]
 *       Builds the field of a GLB's triangles, closes it, and meshes it three ways: dual contouring with the mesh's
 *       normals (sharp), dual contouring at the crossings' mass points (no QEF), and marching tetrahedra
 *       (scratchbox_geometry.hpp IsosurfaceExtractor) sampling the same field. Writes each as a GLB, clay renders of the
 *       whole and of a detail band, manifold counts, and the distance from the scan's own sharp edges to each mesh.
 */

#include "scratchbox_bvh.hpp"
#include "scratchbox_dual_contour.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_png.hpp"

#include <iostream>
#include <map>
#include <sstream>
#include <thread>

using namespace scratchbox;
using sparse_field::SparseField;
using sparse_field::Vec3;

namespace {

constexpr uint32_t kReqMagic = 0x51434453u;  // "SDCQ"
constexpr uint32_t kResMagic = 0x52434453u;  // "SDCR"
constexpr uint32_t kVersion = 1;

std::string fmt(double v) { std::ostringstream o; o.precision(6); o << v; return o.str(); }

std::string statsJson(const dual_contour::Stats& s) {
    std::ostringstream o;
    o << "{\"cells\":" << s.cells << ",\"patches\":" << s.patches << ",\"multiPatchCells\":" << s.multiPatchCells << ",\"crossingEdges\":" << s.crossingEdges
      << ",\"meshNormals\":" << s.meshNormals << ",\"fieldNormals\":" << s.fieldNormals << ",\"clamped\":" << s.clamped << ",\"vertices\":" << s.vertices
      << ",\"quads\":" << s.quads << ",\"triangles\":" << s.triangles << ",\"degenerateQuads\":" << s.degenerateQuads << ",\"clusters\":" << s.clusters
      << ",\"clusteredVertices\":" << s.clusteredVertices << ",\"ms\":{\"cells\":" << fmt(s.msCells) << ",\"simplify\":" << fmt(s.msSimplify) << ",\"quads\":" << fmt(s.msQuads) << "}}";
    return o.str();
}

/** Edge-manifold audit of an indexed triangle mesh: open and over-shared edges, inconsistent windings, components. */
struct Audit { size_t edges = 0, open = 0, nonManifold = 0, misoriented = 0, components = 0; long long euler = 0; };
Audit audit(const std::vector<float>& pos, const std::vector<uint32_t>& tri) {
    Audit a;
    std::unordered_map<uint64_t, std::array<int, 3>> e;  // undirected edge -> (count, forward, backward)
    e.reserve(tri.size() * 2);
    for (size_t t = 0; t + 2 < tri.size(); t += 3)
        for (int k = 0; k < 3; ++k) {
            const uint32_t u = tri[t + k], v = tri[t + (k + 1) % 3];
            const uint64_t key = u < v ? (uint64_t(u) << 32 | v) : (uint64_t(v) << 32 | u);
            auto& c = e[key];
            ++c[0];
            ++c[u < v ? 1 : 2];
        }
    a.edges = e.size();
    for (const auto& [k, c] : e) {
        if (c[0] == 1) ++a.open;
        else if (c[0] > 2) ++a.nonManifold;
        else if (c[1] != 1 || c[2] != 1) ++a.misoriented;
    }
    const size_t V = pos.size() / 3;
    std::vector<uint32_t> p(V);
    for (uint32_t i = 0; i < V; ++i) p[i] = i;
    auto root = [&](uint32_t x) { while (p[x] != x) x = p[x] = p[p[x]]; return x; };
    std::vector<uint8_t> usedV(V, 0);
    for (size_t t = 0; t + 2 < tri.size(); t += 3) {
        for (int k = 0; k < 3; ++k) usedV[tri[t + k]] = 1;
        const uint32_t r0 = root(tri[t]), r1 = root(tri[t + 1]), r2 = root(tri[t + 2]);
        p[r1] = r0; p[root(r2)] = root(r0);
    }
    size_t nv = 0;
    for (uint32_t i = 0; i < V; ++i) if (usedV[i]) { ++nv; if (root(i) == i) ++a.components; }
    a.euler = static_cast<long long>(nv) - static_cast<long long>(a.edges) + static_cast<long long>(tri.size() / 3);
    return a;
}

std::string auditJson(const Audit& a) {
    std::ostringstream o;
    o << "{\"edges\":" << a.edges << ",\"openEdges\":" << a.open << ",\"nonManifoldEdges\":" << a.nonManifold << ",\"misorientedEdges\":" << a.misoriented
      << ",\"components\":" << a.components << ",\"euler\":" << a.euler << "}";
    return o.str();
}

struct Reader {
    std::vector<uint8_t> buf;
    size_t at = 0;
    void need(size_t n) { if (at + n > buf.size()) throw std::runtime_error("request truncated at byte " + std::to_string(at)); }
    template <class T> T get() { need(sizeof(T)); T v; std::memcpy(&v, buf.data() + at, sizeof(T)); at += sizeof(T); return v; }
    template <class T> void arr(T* out, size_t n) { need(n * sizeof(T)); std::memcpy(out, buf.data() + at, n * sizeof(T)); at += n * sizeof(T); }
};

int runRequest(const std::string& reqPath, const std::string& resPath) {
    Reader r;
    {
        std::ifstream f(reqPath, std::ios::binary);
        if (!f) throw std::runtime_error("cannot read " + reqPath);
        r.buf.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
    }
    if (r.get<uint32_t>() != kReqMagic || r.get<uint32_t>() != kVersion) throw std::runtime_error("not a dual contour request (SDCQ v1)");
    const uint32_t threads = r.get<uint32_t>();
    dual_contour::Options o;
    o.qefTruncation = r.get<double>();
    o.normalMaxM = r.get<double>();
    o.sharp = r.get<uint32_t>() != 0;
    o.simplifyToleranceM = r.get<double>();
    const uint32_t pl = r.get<uint32_t>();
    std::string fieldPath(pl, '\0');
    r.arr(fieldPath.data(), pl);
    const uint32_t V = r.get<uint32_t>();
    std::vector<float> pos(size_t(V) * 3);
    r.arr(pos.data(), pos.size());
    const uint32_t T = r.get<uint32_t>();
    std::vector<uint32_t> idx(size_t(T) * 3);
    r.arr(idx.data(), idx.size());

    FixedThreadPool pool(threads ? threads : std::max(1u, std::thread::hardware_concurrency()));
    const double t0 = sparse_field::detail::now();
    const SparseField F = SparseField::load(fieldPath);
    std::unique_ptr<sparse_field::MeshSource> src;
    if (T) src = std::make_unique<sparse_field::MeshSource>(sparse_field::trianglesOf(pos.data(), V, idx.data(), T));
    const auto res = dual_contour::contour(F, o, pool, src.get());
    const Audit a = audit(res.positions, res.triangles);
    const std::string js = "{\"ok\":true,\"stats\":" + statsJson(res.stats) + ",\"audit\":" + auditJson(a) + ",\"ms\":" + fmt(sparse_field::detail::now() - t0) + "}";
    std::ofstream f(resPath, std::ios::binary);
    const uint32_t hdr[3] = {kResMagic, kVersion, static_cast<uint32_t>(js.size())};
    f.write(reinterpret_cast<const char*>(hdr), 12);
    f.write(js.data(), static_cast<std::streamsize>(js.size()));
    const uint32_t nv = static_cast<uint32_t>(res.positions.size() / 3), nq = static_cast<uint32_t>(res.quads.size() / 4), nt = static_cast<uint32_t>(res.triangles.size() / 3);
    f.write(reinterpret_cast<const char*>(&nv), 4);
    f.write(reinterpret_cast<const char*>(res.positions.data()), sizeof(float) * res.positions.size());
    f.write(reinterpret_cast<const char*>(&nq), 4);
    f.write(reinterpret_cast<const char*>(res.quads.data()), sizeof(uint32_t) * res.quads.size());
    f.write(reinterpret_cast<const char*>(&nt), 4);
    f.write(reinterpret_cast<const char*>(res.triangles.data()), sizeof(uint32_t) * res.triangles.size());
    if (!f) throw std::runtime_error("cannot write " + resPath);
    return 0;
}

// ---------------------------------------------------------------- proof

struct Box { Vec3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300}; };

geometry::ScratchboxMesh toMesh(const std::vector<float>& pos, const std::vector<uint32_t>& tri, const std::string& name) {
    geometry::ScratchboxMesh m(name);
    m.vertices.resize(pos.size() / 3);
    for (size_t i = 0; i < m.vertices.size(); ++i) m.vertices[i].position = math::Vec3(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
    m.indices = tri;
    return m;
}

/** Clay render of a triangle mesh by ray casting (flat facet normals, so creases show as they are). */
texture::ImageBuffer renderMesh(const geometry::ScratchboxMesh& m, const bvh::BvhTree& tree, const Box& box, int up, double az, double el, int W, int H, FixedThreadPool& pool) {
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
    // key light from above and behind the camera's left shoulder, so every view is lit from the front
    Vec3 light = inner_core::add(inner_core::add(inner_core::mul(upv, 0.75), inner_core::mul(fwd, -0.55)), inner_core::mul(right, -0.35));
    light = inner_core::mul(light, 1.0 / inner_core::len(light));
    texture::ImageBuffer img(W, H, 3, 255);
    const double tanH = std::tan(fov * 0.5), aspect = static_cast<double>(W) / H;
    pool.forEach(static_cast<size_t>(H), [&](size_t yy) {
        for (int x = 0; x < W; ++x) {
            const double sx = (2 * (x + 0.5) / W - 1) * tanH * aspect, sy = (1 - 2 * (yy + 0.5) / H) * tanH;
            Vec3 d = inner_core::add(fwd, inner_core::add(inner_core::mul(right, sx), inner_core::mul(camUp, sy)));
            d = inner_core::mul(d, 1.0 / inner_core::len(d));
            uint8_t* px = &img.data[(yy * W + x) * 3];
            const double g = 0.93 + 0.05 * (1 - static_cast<double>(yy) / H);
            px[0] = px[1] = px[2] = static_cast<uint8_t>(255 * g);
            // only the part of the ray inside the box
            double t0 = 0, t1 = 1e300;
            for (int k = 0; k < 3; ++k) {
                if (std::fabs(d[k]) < 1e-12) continue;
                double ta = (box.lo[k] - eye[k]) / d[k], tb = (box.hi[k] - eye[k]) / d[k];
                if (ta > tb) std::swap(ta, tb);
                t0 = std::max(t0, ta); t1 = std::min(t1, tb);
            }
            if (t0 > t1) continue;
            const Vec3 o = inner_core::add(eye, inner_core::mul(d, t0));
            math::Ray ray(math::Vec3(o[0], o[1], o[2]), math::Vec3(d[0], d[1], d[2]));
            bvh::RayHit hit;
            if (!tree.raycast(ray, hit) || hit.t > t1 - t0) continue;
            const auto& v0 = m.vertices[m.indices[3 * hit.triangleIndex]].position, &v1 = m.vertices[m.indices[3 * hit.triangleIndex + 1]].position,
                        &v2 = m.vertices[m.indices[3 * hit.triangleIndex + 2]].position;
            Vec3 n = inner_core::cross(Vec3{v1.x - v0.x, v1.y - v0.y, v1.z - v0.z}, Vec3{v2.x - v0.x, v2.y - v0.y, v2.z - v0.z});
            const double nl = inner_core::len(n);
            n = nl > 0 ? inner_core::mul(n, 1.0 / nl) : inner_core::mul(d, -1);
            if (inner_core::dot(n, d) > 0) n = inner_core::mul(n, -1);
            const double shade = std::clamp(0.16 + 0.62 * std::max(0.0, inner_core::dot(n, light)) + 0.22 * (0.5 + 0.5 * n[up]), 0.0, 1.0);
            px[0] = static_cast<uint8_t>(shade * 236); px[1] = static_cast<uint8_t>(shade * 226); px[2] = static_cast<uint8_t>(shade * 212);
        }
    });
    return img;
}

void putPng(const std::string& path, const texture::ImageBuffer& img) {
    const auto bytes = png::encode(img);
    std::ofstream f(path, std::ios::binary);
    f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}

void putGlb(const std::string& path, const geometry::ScratchboxMesh& m) {
    const auto bytes = io::GlbWriter::writeGlb(m);
    std::ofstream f(path, std::ios::binary);
    f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}

std::vector<double> parseList(const std::string& s) {
    std::vector<double> out;
    std::stringstream ss(s);
    std::string t;
    while (std::getline(ss, t, ',')) if (!t.empty()) out.push_back(std::stod(t));
    return out;
}

/**
 * Points along the scan's sharp edges (dihedral above minDeg between two triangles, both sides kept by the closing)
 * spaced every `step` metres within the region the closing left alone (the closed field within a voxel of the scan).
 */
std::vector<Vec3> sharpEdgeSamples(const std::vector<float>& pos, const std::vector<uint32_t>& idx, double minDeg, double step, const Box& region) {
    std::map<std::pair<uint32_t, uint32_t>, std::vector<uint32_t>> edges;
    // weld on exact positions first (tiles share vertices only where welded)
    std::unordered_map<uint64_t, uint32_t> weld;
    std::vector<uint32_t> id(pos.size() / 3);
    for (uint32_t i = 0; i < id.size(); ++i) {
        uint32_t b[3];
        std::memcpy(b, &pos[3 * i], 12);
        const uint64_t k = (uint64_t(b[0]) * 0x9E3779B97F4A7C15ull) ^ (uint64_t(b[1]) * 0xC2B2AE3D27D4EB4Full) ^ (uint64_t(b[2]) << 1);
        id[i] = weld.emplace(k, i).first->second;
    }
    for (uint32_t t = 0; t * 3 + 2 < idx.size(); ++t)
        for (int k = 0; k < 3; ++k) {
            uint32_t u = id[idx[3 * t + k]], v = id[idx[3 * t + (k + 1) % 3]];
            if (u > v) std::swap(u, v);
            edges[{u, v}].push_back(t);
        }
    auto P = [&](uint32_t i) { return Vec3{pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]}; };
    auto N = [&](uint32_t t) {
        const Vec3 n = inner_core::cross(inner_core::sub(P(idx[3 * t + 1]), P(idx[3 * t])), inner_core::sub(P(idx[3 * t + 2]), P(idx[3 * t])));
        const double l = inner_core::len(n);
        return l > 0 ? inner_core::mul(n, 1.0 / l) : n;
    };
    const double cosMax = std::cos(minDeg * M_PI / 180);
    std::vector<Vec3> out;
    for (const auto& [e, ts] : edges) {
        if (ts.size() != 2) continue;
        if (inner_core::dot(N(ts[0]), N(ts[1])) > cosMax) continue;
        const Vec3 a = P(e.first), b = P(e.second);
        const double L = inner_core::len(inner_core::sub(b, a));
        const int n = std::max(1, static_cast<int>(L / step));
        for (int i = 0; i < n; ++i) {
            const Vec3 p = inner_core::add(a, inner_core::mul(inner_core::sub(b, a), (i + 0.5) / n));
            bool in = true;
            for (int k = 0; k < 3; ++k) in = in && p[k] >= region.lo[k] && p[k] <= region.hi[k];
            if (in) out.push_back(p);
        }
    }
    return out;
}

int runProof(int argc, char** argv) {
    std::string glb, out;
    double voxel = 0.05, closeR = 1.0, simplify = 0, mtVoxel = 0;
    int up = 1, size = 900;
    std::vector<double> crop, detail;
    for (int i = 2; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { if (i + 1 >= argc) throw std::runtime_error(a + " needs a value"); return argv[++i]; };
        if (a == "--glb") glb = next();
        else if (a == "--out") out = next();
        else if (a == "--voxel") voxel = std::stod(next());
        else if (a == "--close") closeR = std::stod(next());
        else if (a == "--crop") crop = parseList(next());
        else if (a == "--detail") detail = parseList(next());
        else if (a == "--up") { const std::string u = next(); up = u == "x" ? 0 : u == "z" ? 2 : 1; }
        else if (a == "--size") size = std::stoi(next());
        else if (a == "--simplify") simplify = std::stod(next());
        else if (a == "--mt-voxel") mtVoxel = std::stod(next());
        else throw std::runtime_error("unknown option " + a);
    }
    if (glb.empty() || out.empty()) throw std::runtime_error("proof needs --glb and --out");
    if (mtVoxel <= 0) mtVoxel = voxel;
    FixedThreadPool pool(std::max(1u, std::thread::hardware_concurrency()));
    auto scene = gltf::GlbSceneReader::readFile(glb);
    std::vector<float> pos;
    for (const auto& v : scene.mesh.vertices) { pos.push_back(v.position.x); pos.push_back(v.position.y); pos.push_back(v.position.z); }
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
    sparse_field::MeshSource src(sparse_field::trianglesOf(pos.data(), pos.size() / 3, idx.data(), idx.size() / 3));
    sparse_field::BuildOptions bo;
    bo.voxel = voxel;
    sparse_field::BuildStats bs;
    double t0 = sparse_field::detail::now();
    SparseField F = sparse_field::build(src, bo, pool, &bs);
    const double msBuild = sparse_field::detail::now() - t0;
    t0 = sparse_field::detail::now();
    if (closeR > 0) {
        if (closeR / 8 > voxel * 1.0001) sparse_field::morphCoarse(F, closeR, false, src, closeR / 8, pool);
        else sparse_field::close(F, closeR, pool);
    }
    const double msClose = sparse_field::detail::now() - t0;
    std::cerr << "field " << F.blocks.size() << " blocks; build " << msBuild << " ms, close " << msClose << " ms\n";

    // reference samples on the scan's own sharp edges, where the closed field still passes within a voxel of them
    Box region = box;
    auto edgesAll = sharpEdgeSamples(pos, idx, 60.0, 0.25, region);
    std::vector<Vec3> edgeSamples;
    for (const auto& p : edgesAll) if (std::fabs(F.sample(p)) < 0.5 * voxel) edgeSamples.push_back(p);
    std::cerr << edgeSamples.size() << " sharp-edge samples\n";

    std::ostringstream js;
    js << "{\"glb\":\"" << glb << "\",\"triangles\":" << src.tris.size() << ",\"voxelM\":" << fmt(voxel) << ",\"closeM\":" << fmt(closeR) << ",\"msBuild\":" << fmt(msBuild)
       << ",\"msClose\":" << fmt(msClose) << ",\"fieldBlocks\":" << F.blocks.size() << ",\"sharpEdgeSamples\":" << edgeSamples.size() << ",\"meshes\":[";
    Box rbox = box;
    for (int k = 0; k < 3; ++k) { rbox.lo[k] -= closeR + F.band; rbox.hi[k] += closeR + F.band; }
    Box dbox = rbox;
    if (detail.size() >= 2) { dbox.lo[up] = detail[0]; dbox.hi[up] = detail[1]; }
    const double daz = detail.size() >= 3 ? detail[2] : 45.0;

    auto emit = [&](const std::string& name, const std::vector<float>& P, const std::vector<uint32_t>& T, double ms, const std::string& extra, bool first) {
        const Audit a = audit(P, T);
        geometry::ScratchboxMesh m = toMesh(P, T, name);
        putGlb(out + "/" + name + ".glb", m);
        bvh::BvhTree tree;
        tree.build(m);
        putPng(out + "/" + name + "_view.png", renderMesh(m, tree, rbox, up, 45.0, 18.0, size * 3 / 4, size, pool));
        if (detail.size() >= 2) putPng(out + "/" + name + "_detail.png", renderMesh(m, tree, dbox, up, daz, 22.0, size * 4 / 3, size, pool));
        // distance from the scan's sharp edges to this mesh
        std::vector<inner_core::detail::Tri> tris;
        for (size_t t = 0; t + 2 < T.size(); t += 3)
            tris.push_back({{P[3 * T[t]], P[3 * T[t] + 1], P[3 * T[t] + 2]}, {P[3 * T[t + 1]], P[3 * T[t + 1] + 1], P[3 * T[t + 1] + 2]}, {P[3 * T[t + 2]], P[3 * T[t + 2] + 1], P[3 * T[t + 2] + 2]}});
        inner_core::detail::Bvh nb(tris);
        std::vector<double> d(edgeSamples.size());
        pool.forEach(edgeSamples.size(), [&](size_t i) { d[i] = nb.nearestWithin(edgeSamples[i], 1.0); });
        double rms = 0;
        for (double x : d) rms += x * x;
        rms = d.empty() ? 0 : std::sqrt(rms / d.size());
        std::vector<double> sd = d;
        std::sort(sd.begin(), sd.end());
        const double p50 = sd.empty() ? 0 : sd[sd.size() / 2], p90 = sd.empty() ? 0 : sd[sd.size() * 9 / 10];
        js << (first ? "" : ",") << "{\"name\":\"" << name << "\",\"vertices\":" << P.size() / 3 << ",\"triangles\":" << T.size() / 3 << ",\"ms\":" << fmt(ms)
           << ",\"audit\":" << auditJson(a) << ",\"sharpEdgeDistanceM\":{\"rms\":" << fmt(rms) << ",\"p50\":" << fmt(p50) << ",\"p90\":" << fmt(p90) << "}"
           << (extra.empty() ? "" : ",\"dc\":" + extra) << "}";
        std::cerr << name << ": " << T.size() / 3 << " triangles, open " << a.open << ", non-manifold " << a.nonManifold << ", edge rms " << rms << "\n";
    };
    {
        dual_contour::Options o;
        o.sharp = true;
        t0 = sparse_field::detail::now();
        const auto r = dual_contour::contour(F, o, pool, &src);
        emit("dc_sharp", r.positions, r.triangles, sparse_field::detail::now() - t0, statsJson(r.stats), true);
    }
    if (simplify > 0) {
        dual_contour::Options o;
        o.sharp = true;
        o.simplifyToleranceM = simplify;
        t0 = sparse_field::detail::now();
        const auto r = dual_contour::contour(F, o, pool, &src);
        emit("dc_sharp_simplified", r.positions, r.triangles, sparse_field::detail::now() - t0, statsJson(r.stats), false);
    }
    {
        dual_contour::Options o;
        o.sharp = false;
        t0 = sparse_field::detail::now();
        const auto r = dual_contour::contour(F, o, pool, nullptr);
        emit("dc_masspoint", r.positions, r.triangles, sparse_field::detail::now() - t0, statsJson(r.stats), false);
    }
    {
        // marching tetrahedra over the same field (sampled through the same trilinear lookup) at mtVoxel
        t0 = sparse_field::detail::now();
        math::AABB bb;
        bb.min = math::Vec3(rbox.lo[0], rbox.lo[1], rbox.lo[2]);
        bb.max = math::Vec3(rbox.hi[0], rbox.hi[1], rbox.hi[2]);
        const int nx = static_cast<int>(std::ceil((rbox.hi[0] - rbox.lo[0]) / mtVoxel)), ny = static_cast<int>(std::ceil((rbox.hi[1] - rbox.lo[1]) / mtVoxel)),
                  nz = static_cast<int>(std::ceil((rbox.hi[2] - rbox.lo[2]) / mtVoxel));
        auto field = [&](const math::Vec3& p) { return F.sample({p.x, p.y, p.z}); };
        auto m = geometry::IsosurfaceExtractor::extract(field, bb, nx, ny, nz, 0.0f, 0, true);
        std::vector<float> P;
        for (const auto& v : m.vertices) { P.push_back(v.position.x); P.push_back(v.position.y); P.push_back(v.position.z); }
        emit("marching_tetrahedra", P, m.indices, sparse_field::detail::now() - t0, "", false);
    }
    js << "]}";
    std::ofstream(out + "/report.json") << js.str() << "\n";
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc >= 4 && std::string(argv[1]) == "run") return runRequest(argv[2], argv[3]);
        if (argc >= 2 && std::string(argv[1]) == "proof") return runProof(argc, argv);
        std::cerr << "usage: dual_contour_native run <request.bin> <result.bin>\n       dual_contour_native proof --glb <scan.glb> --out <dir> [options]\n";
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "dual_contour_native: " << e.what() << "\n";
        return 1;
    }
}
