/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Kelvinlet deformer checks on real meshes (a UV sphere and a revolved vase), printed as one JSON object for
 * packages/core/test/kelvinlet-deformer.test.ts. With an output directory it also writes the proof meshes: each
 * shape untouched, under the shaper's plain-falloff brushes and under the Kelvinlet loads (grab, twist, pinch); further
 * name:path arguments add meshes read from disk (e.g. a copy cut from cached tiles) to the proof.
 ********************************************************************************/

#include "scratchbox_kelvinlet.hpp"
#include "scratchbox_shaper.hpp"
#include "scratchbox_io.hpp"

#include <cmath>
#include <cstdio>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <functional>
#include <map>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace scratchbox;
using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::ScratchboxMesh;
namespace kv = scratchbox::kelvinlet;

static double signedVolume(const ScratchboxMesh& m) {
    double v = 0;
    for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
        const Vec3& a = m.vertices[m.indices[i]].position;
        const Vec3& b = m.vertices[m.indices[i + 1]].position;
        const Vec3& c = m.vertices[m.indices[i + 2]].position;
        v += (double)a.x * ((double)b.y * c.z - (double)b.z * c.y)
           - (double)a.y * ((double)b.x * c.z - (double)b.z * c.x)
           + (double)a.z * ((double)b.x * c.y - (double)b.y * c.x);
    }
    return v / 6.0;
}

static ScratchboxMesh sphere() { return geometry::ScratchboxMesh::createSphere(1.0f, 97, 193); }

/** A generated object: a vase revolved from a profile with a swelling body, a neck and a lip. */
static ScratchboxMesh vase() {
    std::vector<Vec2> profile;
    const int n = 121;
    for (int i = 0; i < n; ++i) {
        const float t = (float)i / (n - 1);
        const float y = t * 2.0f;
        float r = 0.32f + 0.38f * std::sin(math::PI * std::min(1.0f, t / 0.8f)) - 0.12f * std::exp(-std::pow((t - 0.86f) / 0.05f, 2.0f))
                + 0.08f * std::exp(-std::pow((t - 0.97f) / 0.03f, 2.0f));
        if (i == 0 || i == n - 1) r = 0.0f;
        profile.push_back(Vec2(r, y));
    }
    ScratchboxMesh m = shaper::Lathe3D::revolve(profile, 160, math::TWO_PI, Vec4(0.8f, 0.8f, 0.8f, 1.0f));
    for (auto& v : m.vertices) v.position.y -= 1.0f;  // centred on the origin
    m.recomputeSmoothNormals();
    m.recomputeBounds();
    return m;
}

static size_t nearestVertex(const ScratchboxMesh& m, const Vec3& p) {
    size_t best = 0;
    float bd = 1e30f;
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        const float d = (m.vertices[i].position - p).lengthSq();
        if (d < bd) { bd = d; best = i; }
    }
    return best;
}

/**
 * The falloff grab and pinch the shaper's sculpt brushes had before the Kelvinlet loads replaced them, kept here as
 * the baseline they are measured against: the grab moves points along the stroke by strength x falloff, the pinch
 * pulls them toward the centre by strength x falloff.
 */
static void plainGrab(ScratchboxMesh& m, const Vec3& c, float radius, float strength, const Vec3& dir) {
    const Vec3 d = dir.normalized();
    for (auto& v : m.vertices) {
        const float w = shaper::SculptEngine::evaluateFalloff((v.position - c).length(), radius, shaper::SculptFalloff::Smoothstep);
        if (w > 0.0f) v.position += d * (strength * w);
    }
    m.recomputeSmoothNormals();
    m.recomputeBounds();
}

static void plainPinch(ScratchboxMesh& m, const Vec3& c, float radius, float strength) {
    for (auto& v : m.vertices) {
        const Vec3 delta = c - v.position;
        const float dist = delta.length();
        if (dist <= 1e-6f) continue;
        const float w = shaper::SculptEngine::evaluateFalloff(dist, radius, shaper::SculptFalloff::Smoothstep);
        if (w > 0.0f) v.position += (delta / dist) * (strength * w);
    }
    m.recomputeSmoothNormals();
    m.recomputeBounds();
}

/** Plain-falloff twist for the comparison: cross-sections near the point turn by angle x smoothstep falloff. */
static void plainTwist(ScratchboxMesh& m, const Vec3& c, const Vec3& axis, float angle, float radius) {
    const Vec3 n = axis.normalized();
    for (auto& v : m.vertices) {
        const Vec3 r = v.position - c;
        const float w = shaper::SculptEngine::evaluateFalloff(r.length(), radius, shaper::SculptFalloff::Smoothstep);
        if (w <= 0.0f) continue;
        const float a = angle * w, cs = std::cos(a), sn = std::sin(a);
        v.position = c + r * cs + n.cross(r) * sn + n * (n.dot(r) * (1.0f - cs));
    }
    m.recomputeSmoothNormals();
    m.recomputeBounds();
}

static void writeGlb(const ScratchboxMesh& m, const std::string& path) {
    const std::vector<uint8_t> bytes = io::GlbWriter::writeGlb(m);
    std::ofstream f(path, std::ios::binary);
    f.write(reinterpret_cast<const char*>(bytes.data()), (std::streamsize)bytes.size());
}

/**
 * How a deformation treats the surface, measured against the mesh before it: the change in dihedral angle across
 * every interior edge (positions welded, so UV seams count as interior), triangles whose normal turned over, the
 * largest edge stretch, and the volume change of a closed mesh.
 */
struct Quality {
    double creaseMaxDeg = 0, creaseP99Deg = 0;
    size_t creasesOver30 = 0, folded = 0, edges = 0;
    double stretchMax = 0, volumeChange = 0;
};

static Quality measure(const ScratchboxMesh& before, const ScratchboxMesh& after) {
    Quality q;
    const float diag = (before.bounds.max - before.bounds.min).length();
    const double cell = 1e-5 * diag;
    std::map<std::array<long long, 3>, uint32_t> weld;
    std::vector<uint32_t> id(before.vertices.size());
    for (size_t i = 0; i < before.vertices.size(); ++i) {
        const Vec3& p = before.vertices[i].position;
        const std::array<long long, 3> k{(long long)std::llround(p.x / cell), (long long)std::llround(p.y / cell), (long long)std::llround(p.z / cell)};
        id[i] = weld.emplace(k, (uint32_t)weld.size()).first->second;
    }
    const size_t nt = before.indices.size() / 3;
    auto normal = [](const ScratchboxMesh& m, size_t t) {  // in double: float32 cross products of thin triangles are noise
        const kv::V3d a(m.vertices[m.indices[3 * t]].position), b(m.vertices[m.indices[3 * t + 1]].position), c(m.vertices[m.indices[3 * t + 2]].position);
        return (b - a).cross(c - a);
    };
    std::vector<kv::V3d> n0(nt), n1(nt);
    std::vector<double> areas;
    for (size_t t = 0; t < nt; ++t) {
        n0[t] = normal(before, t); n1[t] = normal(after, t);
        areas.push_back(n0[t].length());
    }
    // Slivers (a pole's or an axis end's triangles, under a millionth of the median area) have no meaningful normal.
    std::vector<double> sorted = areas;
    std::nth_element(sorted.begin(), sorted.begin() + sorted.size() / 2, sorted.end());
    const double minArea = 1e-6 * sorted[sorted.size() / 2];
    for (size_t t = 0; t < nt; ++t) if (areas[t] > minArea && n1[t].dot(n0[t]) < 0) ++q.folded;
    std::map<std::pair<uint32_t, uint32_t>, std::vector<size_t>> edgeFaces;
    for (size_t t = 0; t < nt; ++t) {
        for (int e = 0; e < 3; ++e) {
            const uint32_t i0 = before.indices[3 * t + e], i1 = before.indices[3 * t + (e + 1) % 3];
            const uint32_t a = id[i0], b = id[i1];
            if (a == b) continue;
            edgeFaces[{std::min(a, b), std::max(a, b)}].push_back(t);
            const double l0 = (before.vertices[i1].position - before.vertices[i0].position).length();
            const double l1 = (after.vertices[i1].position - after.vertices[i0].position).length();
            if (l0 > 1e-9 * diag) q.stretchMax = std::max(q.stretchMax, l1 / l0);
        }
    }
    auto angle = [](const kv::V3d& a, const kv::V3d& b) {
        const double la = a.length(), lb = b.length();
        if (la <= 0 || lb <= 0) return 0.0;
        return std::acos(std::clamp(a.dot(b) / (la * lb), -1.0, 1.0)) * 180.0 / math::PI;
    };
    std::vector<double> changes;
    for (const auto& [edge, faces] : edgeFaces) {
        if (faces.size() != 2) continue;
        const double d = std::abs(angle(n1[faces[0]], n1[faces[1]]) - angle(n0[faces[0]], n0[faces[1]]));
        changes.push_back(d);
        if (d > 30.0) ++q.creasesOver30;
    }
    q.edges = changes.size();
    if (!changes.empty()) {
        std::sort(changes.begin(), changes.end());
        q.creaseMaxDeg = changes.back();
        q.creaseP99Deg = changes[(size_t)(0.99 * (changes.size() - 1))];
    }
    const double v0 = signedVolume(before);
    q.volumeChange = std::abs(v0) > 1e-12 ? signedVolume(after) / v0 - 1.0 : 0.0;
    return q;
}

/** Median wall time of `runs` applications of `op` to fresh copies of `base` (ms); the last result is kept in `out`. */
static double timeOp(const ScratchboxMesh& base, ScratchboxMesh& out, const std::function<void(ScratchboxMesh&)>& op, int runs = 5) {
    std::vector<double> ms;
    for (int r = 0; r < runs; ++r) {
        out = base;
        const auto t0 = std::chrono::steady_clock::now();
        op(out);
        ms.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
    }
    std::sort(ms.begin(), ms.end());
    return ms[ms.size() / 2];
}

static std::ostringstream compareJson;
static int compareCount = 0;

static void record(const std::string& name, const std::string& op, const std::string& variant, const Quality& q, double ms, size_t vertices) {
    compareJson << (compareCount++ ? "," : "") << "{\"shape\":\"" << name << "\",\"op\":\"" << op << "\",\"variant\":\"" << variant
                << "\",\"vertices\":" << vertices << ",\"creaseMaxDeg\":" << q.creaseMaxDeg << ",\"creaseP99Deg\":" << q.creaseP99Deg
                << ",\"creasesOver30\":" << q.creasesOver30 << ",\"edges\":" << q.edges << ",\"folded\":" << q.folded
                << ",\"stretchMax\":" << q.stretchMax << ",\"volumeChange\":" << q.volumeChange << ",\"ms\":" << ms << "}";
}

/**
 * The proof meshes for one shape: untouched, under the plain-falloff brushes (radius 2 eps: half strength at eps, as
 * the Kelvinlet grab) and under the
 * Kelvinlet loads at the same load point (grab 1.4 eps along the normal, twist 1.2 rad about the vertical, pinch).
 */
static void writeProof(const std::string& outDir, const std::string& name, const ScratchboxMesh& base, size_t vi, float eps) {
    const Vec3 lp = base.vertices[vi].position;
    Vec3 n = base.vertices[vi].normal;
    n = n.lengthSq() > 1e-12f ? n.normalized() : Vec3(1, 0, 0);
    Vec3 t = Vec3(0, 1, 0).cross(n);
    t = t.lengthSq() > 1e-8f ? t.normalized() : Vec3(1, 0, 0);
    const float plainR = 2.0f * eps;   // the plain brush falls to half at eps, as the Kelvinlet grab does (smoothstep is 0.5 at half its radius)
    const float grab = 1.43f * eps, pinchPull = 0.43f * eps;
    writeGlb(base, outDir + "/" + name + "_original.glb");
    {
        std::ofstream lf(outDir + "/" + name + "_load.json");
        lf << "{\"point\":[" << lp.x << "," << lp.y << "," << lp.z << "],\"normal\":[" << n.x << "," << n.y << "," << n.z << "],\"epsilon\":" << eps << "}";
    }
    kv::Options o; o.epsilon = eps;
    struct Variant { const char* op; const char* variant; std::function<void(ScratchboxMesh&)> apply; };
    const Vec3 up(0, 1, 0);
    // Twist about the vertical through the load point: about the normal it would only slide a smooth surface over itself.
    const std::vector<Variant> variants = {
        {"grab", "plain", [&](ScratchboxMesh& m) { plainGrab(m, lp, plainR, grab, n); }},
        {"grab", "kelvinlet", [&](ScratchboxMesh& m) { kv::deformMesh(m, kv::Load::grab(lp, n * grab), o); }},
        {"twist", "plain", [&](ScratchboxMesh& m) { plainTwist(m, lp, up, 1.2f, plainR); }},
        {"twist", "kelvinlet", [&](ScratchboxMesh& m) { kv::deformMesh(m, kv::Load::twist(lp, up, 1.2f), o); }},
        {"pinch", "plain", [&](ScratchboxMesh& m) { plainPinch(m, lp, plainR, pinchPull); }},
        {"pinch", "kelvinlet", [&](ScratchboxMesh& m) { kv::deformMesh(m, kv::Load::pinch(lp, t, -1.0f), o); }},
    };
    for (const auto& v : variants) {
        ScratchboxMesh m;
        const double ms = timeOp(base, m, v.apply);
        writeGlb(m, outDir + "/" + name + "_" + v.op + "_" + v.variant + ".glb");
        record(name, v.op, v.variant, measure(base, m), ms, base.vertices.size());
    }
}

int main(int argc, char** argv) {
    const std::string outDir = argc > 1 ? argv[1] : "";
    std::ostringstream js;
    js.precision(9);
    js << "{";

    // 1. A grab moves the load point by the asked displacement (the sphere's pole vertex, a big drag).
    {
        ScratchboxMesh m = sphere();
        const size_t pole = nearestVertex(m, Vec3(0, 1, 0));
        const Vec3 p0 = m.vertices[pole].position;
        const Vec3 d(0.25f, 0.9f, -0.1f);
        kv::Options o; o.epsilon = 0.4f;
        const kv::Report rep = kv::deformMesh(m, kv::Load::grab(p0, d), o);
        const Vec3 moved = m.vertices[pole].position - p0;
        js << "\"grab\":{\"asked\":[" << d.x << "," << d.y << "," << d.z << "],\"moved\":[" << moved.x << "," << moved.y << "," << moved.z
           << "],\"error\":" << (moved - d).length() << ",\"steps\":" << rep.steps << "},";
    }

    // 2. Decay with distance: the closed-form field against the formula written out here, and the far-field slope
    //    for one, two and three scales (sharp localisation).
    {
        const double eps = 0.5, nu = 0.5;
        const double a = 1.0 / (4.0 * math::PI), b = a / (4.0 * (1.0 - nu));
        const Vec3 c(0, 0, 0), d(0, 0.01f, 0);  // a small move: the linear regime
        kv::Options o; o.epsilon = (float)eps; o.poissonRatio = (float)nu;
        double maxRelErr = 0;
        js << "\"decay\":{\"samples\":[";
        bool first = true;
        for (double r : {0.0, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0}) {
            const double re = std::sqrt(r * r + eps * eps);
            const double A = (a - b) / re + a * eps * eps / (2 * re * re * re);
            const double A0 = (3 * a - 2 * b) / (2 * eps);
            const double B = b / (re * re * re);
            const double perp = A / A0;               // |u| / |d| perpendicular to the move
            const double along = (A + B * r * r) / A0; // along the move
            const Vec3 up = kv::displacementAt(Vec3((float)r, 0, 0), kv::Load::grab(c, d), o);
            const Vec3 ua = kv::displacementAt(Vec3(0, (float)r, 0), kv::Load::grab(c, d), o);
            const double gotPerp = up.length() / d.length(), gotAlong = ua.length() / d.length();
            maxRelErr = std::max({maxRelErr, std::abs(gotPerp - perp) / perp, std::abs(gotAlong - along) / along});
            js << (first ? "" : ",") << "{\"r\":" << r << ",\"perp\":" << gotPerp << ",\"perpFormula\":" << perp
               << ",\"along\":" << gotAlong << ",\"alongFormula\":" << along << "}";
            first = false;
        }
        js << "],\"maxRelErr\":" << maxRelErr << ",\"slopes\":[";
        for (int sc = 1; sc <= 3; ++sc) {
            kv::Options os = o; os.falloffScales = sc; os.falloffRatio = 1.5f;
            const double r1 = 20.0, r2 = 40.0;
            const double u1 = kv::displacementAt(Vec3((float)r1, 0, 0), kv::Load::grab(c, d), os).length();
            const double u2 = kv::displacementAt(Vec3((float)r2, 0, 0), kv::Load::grab(c, d), os).length();
            js << (sc > 1 ? "," : "") << std::log(u2 / u1) / std::log(r2 / r1);
        }
        js << "],";
        // Integrated small grab on the mesh against the closed form at each vertex.
        ScratchboxMesh m = sphere();
        std::vector<Vec3> before;
        for (auto& v : m.vertices) before.push_back(v.position);
        const Vec3 lp(0, 1, 0), dd(0.001f, 0.002f, 0.0f);
        kv::Options om; om.epsilon = 0.5f;
        kv::deformMesh(m, kv::Load::grab(lp, dd), om);
        double worst = 0;
        for (size_t i = 0; i < before.size(); ++i) {
            const Vec3 want = kv::displacementAt(before[i], kv::Load::grab(lp, dd), om);
            const Vec3 got = m.vertices[i].position - before[i];
            worst = std::max(worst, (double)(got - want).length() / dd.length());
        }
        js << "\"meshVsFormula\":" << worst << "},";
    }

    // 3. Volume: nu = 0.5 keeps it (the field is divergence free), a compressible material does not.
    {
        js << "\"volume\":{";
        for (float nu : {0.5f, 0.2f}) {
            ScratchboxMesh m = sphere();
            const double v0 = signedVolume(m);
            const Vec3 p = Vec3(0.6f, 0.3f, 0.74f).normalized();
            kv::Options o; o.epsilon = 0.5f; o.poissonRatio = nu;
            kv::deformMesh(m, kv::Load::grab(p, p * 0.5f), o);
            const double vg = signedVolume(m);
            ScratchboxMesh q = sphere();
            kv::deformMesh(q, kv::Load::pinch(p, Vec3(1, 0, 0), -0.8f), o);
            const double vp = signedVolume(q);
            js << (nu == 0.5f ? "" : ",") << "\"nu" << (nu == 0.5f ? "50" : "20") << "\":{\"grab\":" << (vg / v0 - 1.0) << ",\"pinch\":" << (vp / v0 - 1.0) << "}";
        }
        js << "},";
    }

    // 4. A twist keeps every point's distance to the axis (and along it): the sphere and the vase.
    {
        js << "\"twist\":{";
        int k = 0;
        for (int shape = 0; shape < 2; ++shape) {
            ScratchboxMesh m = shape == 0 ? sphere() : vase();
            const Vec3 c = shape == 0 ? Vec3(0, 0.2f, 0) : Vec3(0, 0.3f, 0);
            const Vec3 axis = Vec3(0.2f, 1.0f, 0.1f).normalized();
            std::vector<Vec3> before;
            for (auto& v : m.vertices) before.push_back(v.position);
            kv::Options o; o.epsilon = 0.6f; o.falloffScales = shape == 0 ? 1 : 2;
            kv::deformMesh(m, kv::Load::twist(c, axis, 1.5f * math::PI), o);
            double worstRadial = 0, worstAxial = 0, maxMove = 0;
            for (size_t i = 0; i < before.size(); ++i) {
                const Vec3 r0 = before[i] - c, r1 = m.vertices[i].position - c;
                const float a0 = r0.dot(axis), a1 = r1.dot(axis);
                const float d0 = (r0 - axis * a0).length(), d1 = (r1 - axis * a1).length();
                worstRadial = std::max(worstRadial, (double)std::abs(d1 - d0));
                worstAxial = std::max(worstAxial, (double)std::abs(a1 - a0));
                maxMove = std::max(maxMove, (double)(r1 - r0).length());
            }
            js << (k++ ? "," : "") << (shape == 0 ? "\"sphere\"" : "\"vase\"") << ":{\"radialError\":" << worstRadial << ",\"axialError\":" << worstAxial << ",\"maxMove\":" << maxMove << "}";
        }
        js << "},";
    }

    // 5. The affine loads do what was asked at the load point (points a hundredth of epsilon away).
    {
        const Vec3 c(0.1f, -0.2f, 0.3f);
        kv::Options o; o.epsilon = 0.5f; o.poissonRatio = 0.3f;
        const float h = 0.005f;
        std::vector<Vec3> pts = {c + Vec3(h, 0, 0), c + Vec3(0, h, 0), c + Vec3(0, 0, h)};
        std::vector<Vec3> sc = pts;
        kv::deformPoints(sc, kv::Load::scale(c, 1.6f), o);
        const double scaleGot = (sc[0] - c).length() / h;
        std::vector<Vec3> pi = pts;
        kv::deformPoints(pi, kv::Load::pinch(c, Vec3(1, 0, 0), 0.5f), o);
        const double pinchAlong = (pi[0] - c).length() / h, pinchAcross = (pi[1] - c).length() / h;
        std::string incompressibleScale = "accepted";
        try { kv::Options oi = o; oi.poissonRatio = 0.5f; std::vector<Vec3> t = pts; kv::deformPoints(t, kv::Load::scale(c, 1.6f), oi); }
        catch (const std::invalid_argument& e) { incompressibleScale = e.what(); }
        js << "\"affine\":{\"scaleAsked\":1.6,\"scaleGot\":" << scaleGot << ",\"pinchAlongAsked\":" << std::exp(0.5) << ",\"pinchAlong\":" << pinchAlong
           << ",\"pinchAcrossAsked\":" << std::exp(-0.25) << ",\"pinchAcross\":" << pinchAcross << ",\"incompressibleScale\":\"" << incompressibleScale << "\"},";
    }

    // 6. Sharp versions localise: the share of the sphere moved by more than 1% of the drag, at 1, 2 and 3 scales,
    //    with the same core radius; weights hold masked points still.
    {
        js << "\"localise\":[";
        for (int s = 1; s <= 3; ++s) {
            ScratchboxMesh m = sphere();
            std::vector<Vec3> before;
            for (auto& v : m.vertices) before.push_back(v.position);
            kv::Options o; o.epsilon = 0.3f; o.falloffScales = s;
            const Vec3 d(0, 0.3f, 0);
            kv::deformMesh(m, kv::Load::grab(Vec3(0, 1, 0), d), o);
            size_t movedCount = 0;
            for (size_t i = 0; i < before.size(); ++i) if ((m.vertices[i].position - before[i]).length() > 0.01f * d.length()) ++movedCount;
            js << (s > 1 ? "," : "") << (double)movedCount / before.size();
        }
        ScratchboxMesh m = sphere();
        std::vector<float> w(m.vertices.size());
        std::vector<Vec3> before;
        for (size_t i = 0; i < m.vertices.size(); ++i) { w[i] = m.vertices[i].position.x > 0 ? 1.0f : 0.0f; before.push_back(m.vertices[i].position); }
        kv::Options o; o.epsilon = 0.5f;
        kv::deformMesh(m, kv::Load::grab(Vec3(0, 1, 0), Vec3(0, 0.5f, 0)), o, &w);
        double heldMove = 0;
        for (size_t i = 0; i < before.size(); ++i) if (w[i] == 0.0f) heldMove = std::max(heldMove, (double)(m.vertices[i].position - before[i]).length());
        js << "],\"maskedMaxMove\":" << heldMove;
    }
    js << "}";
    std::cout << js.str() << std::endl;

    if (!outDir.empty()) {
        std::filesystem::create_directories(outDir);
        for (int shape = 0; shape < 2; ++shape) {
            const ScratchboxMesh base = shape == 0 ? sphere() : vase();
            // A load point on the side facing the camera.
            const Vec3 p = shape == 0 ? Vec3(0.6f, 0.3f, 0.74f).normalized() : Vec3(0.42f, -0.1f, 0.52f);
            writeProof(outDir, shape == 0 ? "sphere" : "vase", base, nearestVertex(base, p), shape == 0 ? 0.35f : 0.3f);
        }
        // Further meshes given as name:path[:u,v,w] (a copy of real data; the file is only read): the load point is the
        // vertex nearest that fraction of the bounds (default 1, 0.6, 1: the +X +Z edge at 60% of the height),
        // epsilon a twentieth of the diagonal.
        for (int i = 2; i < argc; ++i) {
            const std::string arg = argv[i];
            const size_t c1 = arg.find(':');
            if (c1 == std::string::npos) { std::cerr << "expected name:path[:u,v,w], got " << arg << "\n"; return 2; }
            const size_t c2 = arg.find(':', c1 + 1);
            const std::string path = arg.substr(c1 + 1, c2 == std::string::npos ? std::string::npos : c2 - c1 - 1);
            float fu = 1.0f, fv = 0.6f, fw = 1.0f;
            if (c2 != std::string::npos && std::sscanf(arg.c_str() + c2 + 1, "%f,%f,%f", &fu, &fv, &fw) != 3) {
                std::cerr << "expected u,v,w after the path in " << arg << "\n"; return 2;
            }
            ScratchboxMesh base = io::GlbReader::readGlb(path);
            base.recomputeSmoothNormals();
            base.recomputeBounds();
            const Vec3 lo = base.bounds.min, size = base.bounds.max - base.bounds.min;
            const Vec3 target(lo.x + fu * size.x, lo.y + fv * size.y, lo.z + fw * size.z);
            writeProof(outDir, arg.substr(0, c1), base, nearestVertex(base, target), 0.05f * size.length());
        }
        std::ofstream cf(outDir + "/compare.json");
        cf << "[" << compareJson.str() << "]";
    }
    return 0;
}
