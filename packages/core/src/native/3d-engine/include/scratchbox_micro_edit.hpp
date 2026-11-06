/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Micro-edit geometry (staged-location/micro-edits.ts): builds the primitives of a building's micro-edit plan from their
 * continuous parameters, one part per edit, so every edit's surface can be measured and labelled on its own. Three of the
 * four universal operators, nothing named:
 *  - `rev`: a harmonic solid of revolution about a vertical axis: a meridian polyline (r, y), K radial lobes of a given
 *    amplitude and edge exponent, and a helical twist. Each meridian segment is its own strip with that segment's normal,
 *    so a rim or a step stays sharp;
 *  - `sweep`: an elliptical profile swept along a carrier polyline (open, capped; or closed), its frame from the carrier's
 *    tangent and an up vector, the profile turned about the carrier by an angle varying linearly from start to end;
 *  - `rep`: the part's previous primitive replicated about a vertical axis at a continuous angular pitch (count copies).
 *
 * Input, one primitive per line (whitespace separated):
 *   part <id>
 *   rev <cx> <cz> <segments> <lobes> <lobeAmp> <lobeExp> <twistRadPerM> <phase> <n> r0 y0 r1 y1 ...
 *   sweep <halfWidth> <halfThickness> <twist0> <twist1> <closed 0|1> <profileN> <upx> <upy> <upz> <n> x0 y0 z0 ...
 *   rep <count> <cx> <cz> <phase>
 * Output: mesh.bin (per part: positions f32 x3, normals f32 x3, indices u32) and report.json (each part's offset, counts,
 * surface area and bounds).
 */

#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace micro_edit {

using V3 = std::array<double, 3>;

inline V3 sub(const V3& a, const V3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline V3 add(const V3& a, const V3& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
inline V3 mul(const V3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
inline double dot(const V3& a, const V3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline V3 cross(const V3& a, const V3& b) { return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]}; }
inline double len(const V3& a) { return std::sqrt(dot(a, a)); }
inline V3 unit(const V3& a) { const double l = len(a); return l > 1e-12 ? mul(a, 1.0 / l) : V3{0, 0, 0}; }

struct Mesh {
    std::vector<float> pos, nrm;
    std::vector<uint32_t> idx;
    uint32_t vertex(const V3& p, const V3& n) {
        const uint32_t i = static_cast<uint32_t>(pos.size() / 3);
        for (int k = 0; k < 3; ++k) { pos.push_back(static_cast<float>(p[k])); nrm.push_back(static_cast<float>(n[k])); }
        return i;
    }
    V3 at(uint32_t i) const { return {pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]}; }
    V3 normalAt(uint32_t i) const { return {nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]}; }
    /** A triangle wound so its face normal agrees with its vertices' normals; degenerate ones are dropped. */
    void tri(uint32_t a, uint32_t b, uint32_t c) {
        const V3 fn = cross(sub(at(b), at(a)), sub(at(c), at(a)));
        if (len(fn) < 1e-14) return;
        const V3 vn = add(add(normalAt(a), normalAt(b)), normalAt(c));
        if (dot(fn, vn) < 0) std::swap(b, c);
        idx.push_back(a); idx.push_back(b); idx.push_back(c);
    }
    double area() const {
        double s = 0;
        for (size_t t = 0; t + 2 < idx.size(); t += 3) s += 0.5 * len(cross(sub(at(idx[t + 1]), at(idx[t])), sub(at(idx[t + 2]), at(idx[t]))));
        return s;
    }
};

/** Operator 2: a harmonic solid of revolution about the vertical axis through (cx, cz). */
struct Revolution {
    double cx = 0, cz = 0;
    int segments = 96;
    int lobes = 0;
    /** r(theta) = r (1 + lobeAmp g(phi)), g = ((1 + cos phi) / 2)^lobeExp, phi = lobes (theta - phase - twist y). */
    double lobeAmp = 0, lobeExp = 1, twistRadPerM = 0, phase = 0;
    /** (r, y), from the bottom axis out, up and back in to the top axis; r = 0 is on the axis. */
    std::vector<std::array<double, 2>> meridian;
};

inline double lobeFactor(const Revolution& R, double theta, double y) {
    if (R.lobes <= 0 || R.lobeAmp == 0) return 1.0;
    const double phi = R.lobes * (theta - R.phase - R.twistRadPerM * y);
    return 1.0 + R.lobeAmp * std::pow(0.5 + 0.5 * std::cos(phi), R.lobeExp);
}

inline void lathe(const Revolution& R, Mesh& m) {
    if (R.meridian.size() < 2) throw std::runtime_error("rev: a meridian needs at least two points");
    const int S = std::max(8, R.segments);
    const double PI = 3.14159265358979323846;
    for (size_t i = 0; i + 1 < R.meridian.size(); ++i) {
        const auto [r0, y0] = R.meridian[i];
        const auto [r1, y1] = R.meridian[i + 1];
        const double dr = r1 - r0, dy = y1 - y0;
        if (std::hypot(dr, dy) < 1e-9) continue;
        // the segment's normal in the meridian plane: (dy, -dr), outward for a meridian walked bottom -> out -> up -> in
        const double nl = std::hypot(dr, dy), nr = dy / nl, ny = -dr / nl;
        std::vector<uint32_t> a(S), b(S);
        for (int j = 0; j < S; ++j) {
            const double th = (2 * PI * j) / S, c = std::cos(th), s = std::sin(th);
            const V3 n{nr * c, ny, nr * s};
            const double f0 = lobeFactor(R, th, y0), f1 = lobeFactor(R, th, y1);
            a[j] = m.vertex({R.cx + r0 * f0 * c, y0, R.cz + r0 * f0 * s}, n);
            b[j] = m.vertex({R.cx + r1 * f1 * c, y1, R.cz + r1 * f1 * s}, n);
        }
        for (int j = 0; j < S; ++j) {
            const int k = (j + 1) % S;
            m.tri(a[j], b[j], b[k]);
            m.tri(a[j], b[k], a[k]);
        }
    }
}

/** Operator 1: an elliptical profile swept along a carrier polyline. */
struct Sweep {
    double halfWidth = 0.05, halfThickness = 0.01;
    /** The profile's turn about the carrier (radians), linear in arc length from start to end. */
    double twist0 = 0, twist1 = 0;
    bool closed = false;
    int profileN = 8;
    V3 up{0, 1, 0};
    std::vector<V3> carrier;
};

inline void sweep(const Sweep& W, Mesh& m) {
    const size_t n = W.carrier.size();
    if (n < 2) throw std::runtime_error("sweep: a carrier needs at least two points");
    const int P = std::max(3, W.profileN);
    const double PI = 3.14159265358979323846;
    std::vector<double> arc(n, 0.0);
    for (size_t k = 1; k < n; ++k) arc[k] = arc[k - 1] + len(sub(W.carrier[k], W.carrier[k - 1]));
    const double total = W.closed ? arc[n - 1] + len(sub(W.carrier[0], W.carrier[n - 1])) : arc[n - 1];
    std::vector<std::vector<uint32_t>> rings(n, std::vector<uint32_t>(P));
    std::vector<V3> tangents(n);
    for (size_t k = 0; k < n; ++k) {
        const V3 prev = k > 0 ? W.carrier[k - 1] : (W.closed ? W.carrier[n - 1] : W.carrier[k]);
        const V3 next = k + 1 < n ? W.carrier[k + 1] : (W.closed ? W.carrier[0] : W.carrier[k]);
        const V3 T = unit(sub(next, prev));
        tangents[k] = T;
        V3 S = unit(cross(W.up, T));
        if (len(S) < 0.5) S = unit(cross(V3{1, 0, 0}, T));
        const V3 U = cross(T, S);
        const double tw = W.twist0 + (W.twist1 - W.twist0) * (total > 0 ? arc[k] / total : 0);
        const double ct = std::cos(tw), st = std::sin(tw);
        // the profile's axes turned by the twist about T
        const V3 S2 = add(mul(S, ct), mul(U, st)), U2 = add(mul(U, ct), mul(S, -st));
        for (int j = 0; j < P; ++j) {
            const double ph = (2 * PI * j) / P, c = std::cos(ph), s = std::sin(ph);
            const V3 p = add(W.carrier[k], add(mul(S2, W.halfWidth * c), mul(U2, W.halfThickness * s)));
            const V3 nn = unit(add(mul(S2, c / std::max(1e-9, W.halfWidth)), mul(U2, s / std::max(1e-9, W.halfThickness))));
            rings[k][j] = m.vertex(p, nn);
        }
    }
    const size_t spans = W.closed ? n : n - 1;
    for (size_t k = 0; k < spans; ++k) {
        const auto& A = rings[k];
        const auto& B = rings[(k + 1) % n];
        for (int j = 0; j < P; ++j) {
            const int q = (j + 1) % P;
            m.tri(A[j], B[j], B[q]);
            m.tri(A[j], B[q], A[q]);
        }
    }
    if (!W.closed) {
        // flat caps at both ends
        for (int end = 0; end < 2; ++end) {
            const size_t k = end ? n - 1 : 0;
            const V3 cn = end ? tangents[k] : mul(tangents[k], -1.0);
            std::vector<uint32_t> cap(P);
            for (int j = 0; j < P; ++j) cap[j] = m.vertex(m.at(rings[k][j]), cn);
            const uint32_t centre = m.vertex(W.carrier[k], cn);
            for (int j = 0; j < P; ++j) m.tri(centre, cap[j], cap[(j + 1) % P]);
        }
    }
}

/** Operator 3: the vertices and triangles from `fromVertex` / `fromIndex` replicated `count` times about a vertical axis. */
inline void replicate(Mesh& m, size_t fromVertex, size_t fromIndex, int count, double cx, double cz, double phase) {
    const double PI = 3.14159265358979323846;
    const size_t nv = m.pos.size() / 3 - fromVertex, ni = m.idx.size() - fromIndex;
    for (int c = 1; c < count; ++c) {
        const double a = phase + (2 * PI * c) / count, ca = std::cos(a), sa = std::sin(a);
        const uint32_t base = static_cast<uint32_t>(m.pos.size() / 3);
        for (size_t v = 0; v < nv; ++v) {
            const V3 p = m.at(static_cast<uint32_t>(fromVertex + v)), n = m.normalAt(static_cast<uint32_t>(fromVertex + v));
            const double x = p[0] - cx, z = p[2] - cz;
            m.vertex({cx + x * ca - z * sa, p[1], cz + x * sa + z * ca}, {n[0] * ca - n[2] * sa, n[1], n[0] * sa + n[2] * ca});
        }
        for (size_t i = 0; i < ni; ++i) m.idx.push_back(base + (m.idx[fromIndex + i] - static_cast<uint32_t>(fromVertex)));
    }
}

struct Part { std::string id; Mesh mesh; };

/** Parses the input lines into parts (see the file comment). */
inline std::vector<Part> build(std::istream& in) {
    std::vector<Part> parts;
    size_t lastVertex = 0, lastIndex = 0;
    std::string line;
    int lineNo = 0;
    while (std::getline(in, line)) {
        ++lineNo;
        std::istringstream ss(line);
        std::string op;
        if (!(ss >> op) || op[0] == '#') continue;
        auto need = [&](bool ok) { if (!ok) throw std::runtime_error("line " + std::to_string(lineNo) + ": malformed " + op); };
        if (op == "part") {
            Part p;
            need(static_cast<bool>(ss >> p.id));
            parts.push_back(std::move(p));
            continue;
        }
        if (parts.empty()) throw std::runtime_error("line " + std::to_string(lineNo) + ": a primitive before any part");
        Mesh& m = parts.back().mesh;
        if (op == "rev") {
            Revolution R;
            int n = 0;
            need(static_cast<bool>(ss >> R.cx >> R.cz >> R.segments >> R.lobes >> R.lobeAmp >> R.lobeExp >> R.twistRadPerM >> R.phase >> n));
            for (int k = 0; k < n; ++k) { double r, y; need(static_cast<bool>(ss >> r >> y)); R.meridian.push_back({r, y}); }
            lastVertex = m.pos.size() / 3; lastIndex = m.idx.size();
            lathe(R, m);
        } else if (op == "sweep") {
            Sweep W;
            int closed = 0, n = 0;
            need(static_cast<bool>(ss >> W.halfWidth >> W.halfThickness >> W.twist0 >> W.twist1 >> closed >> W.profileN >> W.up[0] >> W.up[1] >> W.up[2] >> n));
            W.closed = closed != 0;
            for (int k = 0; k < n; ++k) { V3 p; need(static_cast<bool>(ss >> p[0] >> p[1] >> p[2])); W.carrier.push_back(p); }
            lastVertex = m.pos.size() / 3; lastIndex = m.idx.size();
            sweep(W, m);
        } else if (op == "rep") {
            int count = 0;
            double cx = 0, cz = 0, phase = 0;
            need(static_cast<bool>(ss >> count >> cx >> cz >> phase));
            replicate(m, lastVertex, lastIndex, count, cx, cz, phase);
        } else {
            throw std::runtime_error("line " + std::to_string(lineNo) + ": unknown primitive " + op);
        }
    }
    return parts;
}

inline std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) { if (c == '"' || c == '\\') o += '\\'; if (static_cast<unsigned char>(c) < 0x20) { o += ' '; continue; } o += c; }
    return o + "\"";
}

/** Writes mesh.bin and report.json into `dir`. */
inline void write(const std::vector<Part>& parts, const std::string& dir) {
    std::ofstream bin(dir + "/mesh.bin", std::ios::binary);
    std::ostringstream rep;
    rep.precision(9);
    rep << "{\"schema\":\"scratchbox.micro-edit-mesh/1\",\"parts\":[";
    size_t offset = 0;
    for (size_t p = 0; p < parts.size(); ++p) {
        const Mesh& m = parts[p].mesh;
        const size_t nv = m.pos.size() / 3;
        double lo[3] = {1e300, 1e300, 1e300}, hi[3] = {-1e300, -1e300, -1e300};
        for (size_t v = 0; v < nv; ++v) for (int k = 0; k < 3; ++k) { lo[k] = std::min(lo[k], double(m.pos[v * 3 + k])); hi[k] = std::max(hi[k], double(m.pos[v * 3 + k])); }
        if (!nv) for (int k = 0; k < 3; ++k) lo[k] = hi[k] = 0;
        bin.write(reinterpret_cast<const char*>(m.pos.data()), m.pos.size() * 4);
        bin.write(reinterpret_cast<const char*>(m.nrm.data()), m.nrm.size() * 4);
        bin.write(reinterpret_cast<const char*>(m.idx.data()), m.idx.size() * 4);
        rep << (p ? "," : "") << "{\"id\":" << jstr(parts[p].id) << ",\"offset\":" << offset << ",\"vertices\":" << nv << ",\"indices\":" << m.idx.size()
            << ",\"areaM2\":" << m.area() << ",\"min\":[" << lo[0] << "," << lo[1] << "," << lo[2] << "],\"max\":[" << hi[0] << "," << hi[1] << "," << hi[2] << "]}";
        offset += m.pos.size() * 4 + m.nrm.size() * 4 + m.idx.size() * 4;
    }
    rep << "]}";
    std::ofstream(dir + "/report.json") << rep.str();
}

}  // namespace micro_edit
}  // namespace scratchbox
