/********************************************************************************
 * Scratchbox Hard-Surface Mesh Operations
 *
 * Booleans, bevels, inset / extrude and solidify on triangle meshes, each producing a closed
 * 2-manifold from closed input (solidify also closes open input). All work on a welded copy of
 * the input (vertices merged by position) and finish with auto-smooth weighted normals: faces
 * meeting at less than the smoothing angle share normals, except that a face as large as its
 * neighbours keeps its own, so flat faces shade flat, hard edges stay crisp and bevel strips and
 * curved areas shade smoothly.
 *
 *   booleanOp      exact BSP-tree CSG (csg.js method) in double precision with iterative tree
 *                  walks, then welding, debris clean-up and T-junction repair so the result has no
 *                  cracks. The result is checked and an error raised if it is not closed: dense,
 *                  sliver-heavy input (isosurface meshes) is beyond floating-point BSP and belongs in
 *                  sb.sdf, where booleans are exact on the field.
 *   bevel          faces are grouped into smooth regions split at sharp edges; each region's
 *                  border is pulled inward along the surface by the bevel width, sharp edges
 *                  become strips (rounded with segments > 1) and corners become caps.
 *   insetExtrude   faces facing a direction (optionally inside a box) are grouped into regions;
 *                  each region's border ring is duplicated, inset within the face plane, and the
 *                  region pushed along its normal by depth (negative for recessed panels).
 *   solidify       an offset inner copy (reversed) plus rim walls along open edges.
 ********************************************************************************/

#ifndef SCRATCHBOX_MESH_OPS_HPP
#define SCRATCHBOX_MESH_OPS_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_scan_geom.hpp"
#include <vector>
#include <array>
#include <map>
#include <tuple>
#include <set>
#include <unordered_map>
#include <cmath>
#include <algorithm>
#include <string>
#include <stdexcept>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>

namespace scratchbox {
namespace meshops {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::ScratchboxMesh;
using geometry::Vertex;

// --------------------------------------------------------------------------
// Indexed working mesh
// --------------------------------------------------------------------------
struct IndexedMesh {
    std::vector<Vec3> p;
    std::vector<std::array<uint32_t, 3>> t;
};

inline IndexedMesh weld(const ScratchboxMesh& m, float eps = -1.0f) {
    IndexedMesh out;
    if (m.vertices.empty()) return out;
    Vec3 lo = m.vertices[0].position, hi = lo;
    for (const auto& v : m.vertices) {
        lo = Vec3(std::min(lo.x, v.position.x), std::min(lo.y, v.position.y), std::min(lo.z, v.position.z));
        hi = Vec3(std::max(hi.x, v.position.x), std::max(hi.y, v.position.y), std::max(hi.z, v.position.z));
    }
    if (eps <= 0.0f) eps = std::max(1e-7f, (hi - lo).length() * 1e-6f);
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
    auto cellKey = [&](long x, long y, long z) {
        return (static_cast<uint64_t>(x & 0x1fffff) << 42) | (static_cast<uint64_t>(y & 0x1fffff) << 21) | static_cast<uint64_t>(z & 0x1fffff);
    };
    std::vector<uint32_t> remap(m.vertices.size());
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        Vec3 q = m.vertices[i].position;
        long cx = std::lround(std::floor(q.x / eps)), cy = std::lround(std::floor(q.y / eps)), cz = std::lround(std::floor(q.z / eps));
        uint32_t found = UINT32_MAX;
        for (long dx = -1; dx <= 1 && found == UINT32_MAX; ++dx)
            for (long dy = -1; dy <= 1 && found == UINT32_MAX; ++dy)
                for (long dz = -1; dz <= 1 && found == UINT32_MAX; ++dz) {
                    auto it = grid.find(cellKey(cx + dx, cy + dy, cz + dz));
                    if (it == grid.end()) continue;
                    for (uint32_t c : it->second) if ((out.p[c] - q).length() <= eps) { found = c; break; }
                }
        if (found == UINT32_MAX) {
            found = static_cast<uint32_t>(out.p.size());
            out.p.push_back(q);
            grid[cellKey(cx, cy, cz)].push_back(found);
        }
        remap[i] = found;
    }
    for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
        std::array<uint32_t, 3> tri = { remap[m.indices[i]], remap[m.indices[i + 1]], remap[m.indices[i + 2]] };
        if (tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2]) continue;
        out.t.push_back(tri);
    }
    return out;
}

// Welds only vertices whose positions are bit-for-bit equal.
inline IndexedMesh weldExact(const ScratchboxMesh& m) {
    IndexedMesh out;
    std::map<std::array<float, 3>, uint32_t> byPos;
    std::vector<uint32_t> remap(m.vertices.size());
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        const Vec3& q = m.vertices[i].position;
        auto it = byPos.emplace(std::array<float, 3>{q.x, q.y, q.z}, static_cast<uint32_t>(out.p.size()));
        if (it.second) out.p.push_back(q);
        remap[i] = it.first->second;
    }
    for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
        std::array<uint32_t, 3> tri = { remap[m.indices[i]], remap[m.indices[i + 1]], remap[m.indices[i + 2]] };
        if (tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2]) continue;
        out.t.push_back(tri);
    }
    return out;
}

inline size_t badEdges(const IndexedMesh& m);

// Welding for the modelling operations: exact positions first (results of these operations share
// vertices bit for bit, and a tolerance weld could merge distinct close vertices); the relative weld
// only when it leaves fewer open or over-shared edges (noisy seams on authored meshes).
inline IndexedMesh weldForOps(const ScratchboxMesh& m) {
    IndexedMesh exactW = weldExact(m);
    size_t bad = badEdges(exactW);
    if (bad == 0) return exactW;
    IndexedMesh tolW = weld(m);
    return badEdges(tolW) < bad ? tolW : exactW;
}

inline Vec3 faceNormal(const IndexedMesh& m, size_t f) {
    const auto& t = m.t[f];
    Vec3 n = (m.p[t[1]] - m.p[t[0]]).cross(m.p[t[2]] - m.p[t[0]]);
    float len = n.length();
    return len > 1e-20f ? n / len : Vec3(0, 1, 0);
}

inline uint64_t edgeKey(uint32_t a, uint32_t b) {
    return (static_cast<uint64_t>(std::min(a, b)) << 32) | std::max(a, b);
}

// Faces around each undirected edge.
inline std::unordered_map<uint64_t, std::vector<uint32_t>> edgeFaces(const IndexedMesh& m) {
    std::unordered_map<uint64_t, std::vector<uint32_t>> ef;
    ef.reserve(m.t.size() * 2);
    for (size_t f = 0; f < m.t.size(); ++f)
        for (int k = 0; k < 3; ++k) ef[edgeKey(m.t[f][k], m.t[f][(k + 1) % 3])].push_back(static_cast<uint32_t>(f));
    return ef;
}

inline size_t badEdges(const IndexedMesh& m) {
    size_t n = 0;
    for (const auto& [k, fs] : edgeFaces(m)) if (fs.size() != 2) ++n;
    return n;
}

/**
 * Output with auto-smooth normals: each face corner takes the area-weighted normal of the faces
 * around its vertex that meet it at less than smoothAngleDeg, and corners sharing a vertex and a
 * normal share an output vertex.
 */
inline ScratchboxMesh finish(const IndexedMesh& m, const ScratchboxMesh& style, const std::string& name, float smoothAngleDeg = 30.0f) {
    ScratchboxMesh out(name);
    out.material = style.material;
    const float cosLimit = std::cos(smoothAngleDeg * math::DEG_TO_RAD);
    std::vector<Vec3> fn(m.t.size()), fa(m.t.size());
    std::vector<std::vector<uint32_t>> vf(m.p.size());
    for (size_t f = 0; f < m.t.size(); ++f) {
        const auto& t = m.t[f];
        fa[f] = (m.p[t[1]] - m.p[t[0]]).cross(m.p[t[2]] - m.p[t[0]]);
        fn[f] = faceNormal(m, f);
        for (uint32_t v : t) vf[v].push_back(static_cast<uint32_t>(f));
    }
    std::map<std::pair<uint32_t, std::array<int32_t, 3>>, uint32_t> shared;
    Vec4 color = style.vertices.empty() ? Vec4(1, 1, 1, 1) : style.vertices[0].color;
    for (size_t f = 0; f < m.t.size(); ++f) {
        uint32_t idx[3];
        for (int k = 0; k < 3; ++k) {
            uint32_t v = m.t[f][k];
            // Weighted normals: when the faces coplanar with this one (within 1 degree) clearly dominate the
            // smoothing group's area around the vertex, the corner keeps the flat normal (flat faces shade flat
            // beside bevel strips); otherwise it takes the area-weighted average (curved surfaces blend; on a
            // polygonal cylinder each facet holds at most half the area, so the bar sits above a half).
            Vec3 n(0, 0, 0);
            float groupArea = 0.0f, coplanarArea = 0.0f;
            for (uint32_t g : vf[v]) if (fn[g].dot(fn[f]) >= cosLimit) {
                n += fa[g];
                float area = fa[g].length();
                groupArea += area;
                if (fn[g].dot(fn[f]) >= 0.99985f) coplanarArea += area;
            }
            if (coplanarArea > 0.65f * groupArea) n = fn[f];
            n = n.length() > 1e-20f ? n.normalized() : fn[f];
            std::array<int32_t, 3> nk = { static_cast<int32_t>(std::lround(n.x * 1e4)), static_cast<int32_t>(std::lround(n.y * 1e4)), static_cast<int32_t>(std::lround(n.z * 1e4)) };
            auto key = std::make_pair(v, nk);
            auto it = shared.find(key);
            if (it == shared.end()) {
                Vec3 tan = std::abs(n.y) < 0.99f ? Vec3(0, 1, 0).cross(n).normalized() : Vec3(1, 0, 0);
                out.addVertex(Vertex(m.p[v], n, Vec2(0, 0), color, Vec4(tan.x, tan.y, tan.z, 1.0f)));
                it = shared.emplace(key, static_cast<uint32_t>(out.vertices.size() - 1)).first;
            }
            idx[k] = it->second;
        }
        out.addTriangle(idx[0], idx[1], idx[2]);
    }
    out.recomputeBounds();
    return out;
}

// --------------------------------------------------------------------------
// Booleans (BSP-tree CSG)
// --------------------------------------------------------------------------
namespace exact {

// Sign-magnitude integer of 7 x 64-bit limbs (448 bits). Coordinates are integers of up to 40 bits on
// a fixed grid; the largest value any predicate below forms is about 2^375, so 448 bits always suffice.
// Overflow throws rather than wraps.
constexpr int kLimbs = 7;
struct Wide {
    bool neg{false};
    uint64_t m[kLimbs]{0, 0, 0, 0, 0, 0, 0};
    static Wide from(__int128 v) {
        Wide w;
        unsigned __int128 u = v < 0 ? static_cast<unsigned __int128>(-(v + 1)) + 1u : static_cast<unsigned __int128>(v);
        w.neg = v < 0;
        w.m[0] = static_cast<uint64_t>(u);
        w.m[1] = static_cast<uint64_t>(u >> 64);
        return w;
    }
    bool zero() const { for (int i = 0; i < kLimbs; ++i) if (m[i]) return false; return true; }
    int sign() const { return zero() ? 0 : (neg ? -1 : 1); }
};

inline int cmpMag(const Wide& a, const Wide& b) {
    for (int i = kLimbs - 1; i >= 0; --i) if (a.m[i] != b.m[i]) return a.m[i] < b.m[i] ? -1 : 1;
    return 0;
}
inline Wide addMag(const Wide& a, const Wide& b) {
    Wide r;
    unsigned __int128 c = 0;
    for (int i = 0; i < kLimbs; ++i) { c += static_cast<unsigned __int128>(a.m[i]) + b.m[i]; r.m[i] = static_cast<uint64_t>(c); c >>= 64; }
    if (c) throw std::overflow_error("exact boolean predicate overflowed");
    return r;
}
inline Wide subMag(const Wide& a, const Wide& b) {  // requires |a| >= |b|
    Wide r;
    uint64_t borrow = 0;
    for (int i = 0; i < kLimbs; ++i) {
        unsigned __int128 take = static_cast<unsigned __int128>(b.m[i]) + borrow;
        if (static_cast<unsigned __int128>(a.m[i]) >= take) { r.m[i] = static_cast<uint64_t>(a.m[i] - take); borrow = 0; }
        else { r.m[i] = static_cast<uint64_t>((static_cast<unsigned __int128>(1) << 64) + a.m[i] - take); borrow = 1; }
    }
    return r;
}
inline Wide add(const Wide& a, const Wide& b) {
    if (a.neg == b.neg) { Wide r = addMag(a, b); r.neg = a.neg && !r.zero(); return r; }
    int c = cmpMag(a, b);
    if (c == 0) return Wide{};
    Wide r = c > 0 ? subMag(a, b) : subMag(b, a);
    r.neg = c > 0 ? a.neg : b.neg;
    return r;
}
inline Wide negate(Wide a) { if (!a.zero()) a.neg = !a.neg; return a; }
inline Wide mul(const Wide& a, const Wide& b) {
    Wide r;
    for (int i = 0; i < kLimbs; ++i) {
        if (!a.m[i]) continue;
        unsigned __int128 carry = 0;
        for (int j = 0; j < kLimbs; ++j) {
            if (i + j >= kLimbs) { if (b.m[j]) throw std::overflow_error("exact boolean predicate overflowed"); continue; }
            unsigned __int128 cur = static_cast<unsigned __int128>(a.m[i]) * b.m[j] + r.m[i + j] + carry;
            r.m[i + j] = static_cast<uint64_t>(cur);
            carry = cur >> 64;
        }
        if (carry) throw std::overflow_error("exact boolean predicate overflowed");
    }
    r.neg = (a.neg != b.neg) && !r.zero();
    return r;
}

// Plane a x + b y + c z + d = 0 with integer coefficients (normals up to 2^83, offsets up to 2^124).
struct Plane {
    __int128 a{0}, b{0}, c{0};
    __int128 d{0};
    Plane flipped() const { return Plane{-a, -b, -c, -d}; }
};

// det | n1; n2; n3 | of three plane normals, exactly.
inline Wide det3(const Plane& p, const Plane& q, const Plane& r) {
    auto W = [](__int128 v) { return Wide::from(v); };
    Wide m0 = add(mul(W(q.b), W(r.c)), negate(mul(W(q.c), W(r.b))));
    Wide m1 = add(mul(W(q.a), W(r.c)), negate(mul(W(q.c), W(r.a))));
    Wide m2 = add(mul(W(q.a), W(r.b)), negate(mul(W(q.b), W(r.a))));
    Wide t = mul(W(p.a), m0);
    t = add(t, negate(mul(W(p.b), m1)));
    return add(t, mul(W(p.c), m2));
}
inline double det3d(const Plane& p, const Plane& q, const Plane& r, double& absBound) {
    double qa = static_cast<double>(q.a), qb = static_cast<double>(q.b), qc = static_cast<double>(q.c);
    double ra = static_cast<double>(r.a), rb = static_cast<double>(r.b), rc = static_cast<double>(r.c);
    double pa = static_cast<double>(p.a), pb = static_cast<double>(p.b), pc = static_cast<double>(p.c);
    absBound = std::abs(pa) * (std::abs(qb * rc) + std::abs(qc * rb)) + std::abs(pb) * (std::abs(qa * rc) + std::abs(qc * ra)) +
               std::abs(pc) * (std::abs(qa * rb) + std::abs(qb * ra));
    return pa * (qb * rc - qc * rb) - pb * (qa * rc - qc * ra) + pc * (qa * rb - qb * ra);
}

// Sign of plane q at the point where planes s, e1, e2 meet: sign(det4) * sign(det3 of their normals),
// filtered in double precision and exact whenever the double result is too close to call.
inline int orient(const Plane& s, const Plane& e1, const Plane& e2, const Plane& q) {
    const Plane* rows[4] = {&s, &e1, &e2, &q};
    double sumAbs = 0.0, det4 = 0.0, b0;
    double d3 = det3d(s, e1, e2, b0);
    for (int i = 0; i < 4; ++i) {
        const Plane* o[3]; int k = 0;
        for (int j = 0; j < 4; ++j) if (j != i) o[k++] = rows[j];
        double bound;
        double minor = det3d(*o[0], *o[1], *o[2], bound);
        double di = static_cast<double>(rows[i]->d);
        double term = ((i + 3) % 2 == 0 ? 1.0 : -1.0) * di * minor;
        det4 += term;
        sumAbs += std::abs(di) * bound;
    }
    const double rel = 1e-12;
    if (std::abs(det4) > sumAbs * rel && std::abs(d3) > b0 * rel) return (det4 > 0) == (d3 > 0) ? 1 : -1;
    Wide w4;
    for (int i = 0; i < 4; ++i) {
        const Plane* o[3]; int k = 0;
        for (int j = 0; j < 4; ++j) if (j != i) o[k++] = rows[j];
        Wide term = mul(Wide::from(rows[i]->d), det3(*o[0], *o[1], *o[2]));
        w4 = add(w4, (i + 3) % 2 == 0 ? term : negate(term));
    }
    int s4 = w4.sign(), s3 = det3(s, e1, e2).sign();
    return s4 == 0 || s3 == 0 ? 0 : (s4 == s3 ? 1 : -1);
}

// Exact sign of the dot product of two plane normals (for coplanar facing tests).
inline int normalDot(const Plane& p, const Plane& q) {
    Wide t = add(add(mul(Wide::from(p.a), Wide::from(q.a)), mul(Wide::from(p.b), Wide::from(q.b))), mul(Wide::from(p.c), Wide::from(q.c)));
    return t.sign();
}

// A convex polygon held by planes: its supporting plane and its bounding planes in order (interior on
// each one's negative side); vertex i is where s, e[i-1] and e[i] meet. Splitting only ever adds an
// existing plane, so coefficients never grow however many cuts a boolean makes.
struct Polygon {
    Plane s;
    std::vector<Plane> e;
};

inline int vertexSide(const Polygon& p, size_t i, const Plane& q) {
    size_t n = p.e.size();
    return orient(p.s, p.e[(i + n - 1) % n], p.e[i], q);
}

inline void split(const Plane& pl, const Polygon& poly, std::vector<Polygon>& coF, std::vector<Polygon>& coB,
                  std::vector<Polygon>& front, std::vector<Polygon>& back) {
    const size_t n = poly.e.size();
    std::vector<int> side(n);
    bool anyF = false, anyB = false;
    for (size_t i = 0; i < n; ++i) { side[i] = vertexSide(poly, i, pl); anyF |= side[i] > 0; anyB |= side[i] < 0; }
    if (!anyF && !anyB) { (normalDot(poly.s, pl) > 0 ? coF : coB).push_back(poly); return; }
    if (!anyB) { front.push_back(poly); return; }
    if (!anyF) { back.push_back(poly); return; }
    // Edge i runs from vertex i to vertex i+1 on e[i]. A piece keeps every edge with part on its side and
    // closes with the cutting plane right after the edge where it leaves that side.
    auto piece = [&](int sgn, const Plane& closer) {
        Polygon out;
        out.s = poly.s;
        auto has = [&](size_t i) { return side[i] * sgn > 0 || side[(i + 1) % n] * sgn > 0; };
        for (size_t i = 0; i < n; ++i) {
            if (!has(i)) continue;
            out.e.push_back(poly.e[i]);
            size_t j = (i + 1) % n;
            if (side[j] * sgn < 0 || !has(j)) out.e.push_back(closer);
        }
        return out;
    };
    Polygon f = piece(1, pl.flipped()), b = piece(-1, pl);
    if (f.e.size() >= 3) front.push_back(std::move(f));
    if (b.e.size() >= 3) back.push_back(std::move(b));
}

class Bsp {
public:
    void build(std::vector<Polygon> polys) {
        if (polys.empty()) return;
        if (nodes_.empty()) nodes_.push_back(Node{});
        std::vector<std::pair<int, std::vector<Polygon>>> stack;
        stack.emplace_back(0, std::move(polys));
        while (!stack.empty()) {
            auto [ni, list] = std::move(stack.back());
            stack.pop_back();
            if (list.empty()) continue;
            if (!nodes_[ni].hasPlane) { nodes_[ni].plane = list[0].s; nodes_[ni].hasPlane = true; }
            std::vector<Polygon> front, back, coF, coB;
            const Plane pl = nodes_[ni].plane;
            for (const auto& p : list) split(pl, p, coF, coB, front, back);
            for (auto& p : coF) nodes_[ni].polys.push_back(std::move(p));
            for (auto& p : coB) nodes_[ni].polys.push_back(std::move(p));
            if (!front.empty()) {
                if (nodes_[ni].front < 0) { nodes_[ni].front = static_cast<int>(nodes_.size()); nodes_.push_back(Node{}); }
                stack.emplace_back(nodes_[ni].front, std::move(front));
            }
            if (!back.empty()) {
                if (nodes_[ni].back < 0) { nodes_[ni].back = static_cast<int>(nodes_.size()); nodes_.push_back(Node{}); }
                stack.emplace_back(nodes_[ni].back, std::move(back));
            }
        }
    }
    void invert() {
        for (auto& n : nodes_) {
            for (auto& p : n.polys) { p.s = p.s.flipped(); std::reverse(p.e.begin(), p.e.end()); }
            n.plane = n.plane.flipped();
            std::swap(n.front, n.back);
        }
    }
    std::vector<Polygon> clipPolygons(std::vector<Polygon> polys) const {
        if (nodes_.empty()) return polys;
        std::vector<Polygon> kept;
        std::vector<std::pair<int, std::vector<Polygon>>> stack;
        stack.emplace_back(0, std::move(polys));
        while (!stack.empty()) {
            auto [ni, list] = std::move(stack.back());
            stack.pop_back();
            const Node& n = nodes_[ni];
            if (!n.hasPlane) { for (auto& p : list) kept.push_back(std::move(p)); continue; }
            std::vector<Polygon> front, back;
            for (const auto& p : list) split(n.plane, p, front, back, front, back);
            if (n.front >= 0) stack.emplace_back(n.front, std::move(front));
            else for (auto& p : front) kept.push_back(std::move(p));
            if (n.back >= 0) stack.emplace_back(n.back, std::move(back));
        }
        return kept;
    }
    void clipTo(const Bsp& other) { for (auto& n : nodes_) n.polys = other.clipPolygons(std::move(n.polys)); }
    std::vector<Polygon> allPolygons() const {
        std::vector<Polygon> all;
        for (const auto& n : nodes_) all.insert(all.end(), n.polys.begin(), n.polys.end());
        return all;
    }
private:
    struct Node { Plane plane; bool hasPlane{false}; int front{-1}, back{-1}; std::vector<Polygon> polys; };
    std::vector<Node> nodes_;
};

inline long double toLongDouble(const Wide& w) {
    long double v = 0.0L, base = 1.0L;
    for (int i = 0; i < kLimbs; ++i) { v += static_cast<long double>(w.m[i]) * base; base *= 18446744073709551616.0L; }
    return w.neg ? -v : v;
}

inline Wide det3w(const Wide M[3][3]) {
    Wide t = mul(M[0][0], add(mul(M[1][1], M[2][2]), negate(mul(M[1][2], M[2][1]))));
    t = add(t, negate(mul(M[0][1], add(mul(M[1][0], M[2][2]), negate(mul(M[1][2], M[2][0]))))));
    return add(t, mul(M[0][2], add(mul(M[1][0], M[2][1]), negate(mul(M[1][1], M[2][0])))));
}

// The point where three planes meet, in grid units. Numerators and denominator are exact integers and are
// only divided at the end, so the same exact point always comes out at the same coordinates, however
// nearly parallel the planes that define it are.
inline bool meet(const Plane& p, const Plane& q, const Plane& r, long double out[3]) {
    const Plane* P[3] = {&p, &q, &r};
    Wide N[3][3], rhs[3];
    for (int i = 0; i < 3; ++i) {
        N[i][0] = Wide::from(P[i]->a); N[i][1] = Wide::from(P[i]->b); N[i][2] = Wide::from(P[i]->c);
        rhs[i] = negate(Wide::from(P[i]->d));
    }
    Wide D = det3w(N);
    if (D.zero()) return false;
    long double den = toLongDouble(D);
    for (int c = 0; c < 3; ++c) {
        Wide M[3][3];
        for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) M[i][j] = j == c ? rhs[i] : N[i][j];
        out[c] = toLongDouble(det3w(M)) / den;
    }
    return true;
}

} // namespace exact

enum class BooleanKind { Union, Subtract, Intersect };

// Triangulates triangle (a, b, c) whose edges carry extra points (ab: points on a->b in order, and
// so on) using only those points: fan from a corner across the points on its opposite edge, which
// are never collinear with it; only the fan's two outer triangles can still carry points (on the
// corner's own edges) and each is split the same way from its new apex. Winding is preserved.
inline void splitTriangle(uint32_t a, uint32_t b, uint32_t c, const std::vector<uint32_t>& ab, const std::vector<uint32_t>& bc,
                          const std::vector<uint32_t>& ca, std::vector<std::array<uint32_t, 3>>& out) {
    if (ab.empty() && bc.empty() && ca.empty()) { out.push_back({a, b, c}); return; }
    // Rotate so the fanning corner is first: prefer a corner whose own edges carry nothing.
    uint32_t v[3] = {a, b, c};
    const std::vector<uint32_t>* e[3] = {&ab, &bc, &ca};   // e[k] runs v[k] -> v[k+1]
    int corner = -1;
    for (int k = 0; k < 3 && corner < 0; ++k) if (!e[(k + 1) % 3]->empty() && e[k]->empty() && e[(k + 2) % 3]->empty()) corner = k;
    for (int k = 0; k < 3 && corner < 0; ++k) if (!e[(k + 1) % 3]->empty()) corner = k;
    const uint32_t x = v[corner], y = v[(corner + 1) % 3], z = v[(corner + 2) % 3];
    const std::vector<uint32_t>& xy = *e[corner];
    const std::vector<uint32_t>& yz = *e[(corner + 1) % 3];
    const std::vector<uint32_t>& zx = *e[(corner + 2) % 3];
    // Fan from x across y, yz..., z.
    std::vector<uint32_t> chain;
    chain.push_back(y);
    chain.insert(chain.end(), yz.begin(), yz.end());
    chain.push_back(z);
    static const std::vector<uint32_t> none;
    for (size_t i = 0; i + 1 < chain.size(); ++i) {
        bool first = i == 0, last = i + 2 == chain.size();
        // The first fan triangle keeps edge x->y (with xy's points); the last keeps z->x (with zx's).
        splitTriangle(x, chain[i], chain[i + 1], first ? xy : none, none, last ? zx : none, out);
    }
}

// Splits triangle edges at welded vertices lying on them, so neighbours that were cut
// differently share their vertices (no T-junctions, no cracks). A triangle that gains points on
// its edges is re-triangulated from those points alone (splitTriangle), never adding vertices: a
// new interior point of a thin triangle could itself land on a neighbour's edge and cascade.
inline void repairTJunctions(IndexedMesh& m, float eps) {
    if (m.t.empty()) return;
    std::vector<float> lengths;
    for (const auto& t : m.t) for (int k = 0; k < 3; ++k) lengths.push_back((m.p[t[k]] - m.p[t[(k + 1) % 3]]).length());
    std::nth_element(lengths.begin(), lengths.begin() + lengths.size() / 2, lengths.end());
    const float cell = std::max(lengths[lengths.size() / 2], eps * 16.0f);
    auto key = [](long x, long y, long z) { return (static_cast<uint64_t>(x & 0x1fffff) << 42) | (static_cast<uint64_t>(y & 0x1fffff) << 21) | static_cast<uint64_t>(z & 0x1fffff); };
    auto cellOf = [&](const Vec3& q) { return std::array<long, 3>{ std::lround(std::floor(q.x / cell)), std::lround(std::floor(q.y / cell)), std::lround(std::floor(q.z / cell)) }; };
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
    for (uint32_t i = 0; i < m.p.size(); ++i) { auto c = cellOf(m.p[i]); grid[key(c[0], c[1], c[2])].push_back(i); }

    // Vertices strictly inside each undirected edge, ordered from its lower to its higher index.
    std::unordered_map<uint64_t, std::vector<uint32_t>> inside;
    for (const auto& t : m.t) for (int k = 0; k < 3; ++k) {
        uint32_t a = std::min(t[k], t[(k + 1) % 3]), b = std::max(t[k], t[(k + 1) % 3]);
        uint64_t ek = edgeKey(a, b);
        if (inside.count(ek)) continue;
        std::vector<std::pair<float, uint32_t>> on;
        Vec3 A = m.p[a], B = m.p[b], d = B - A;
        float len2 = d.dot(d);
        if (len2 > 1e-30f) {
            // Walk the cells along the segment (with their neighbours), not its whole bounding box.
            std::unordered_map<uint64_t, char> visited;
            int steps = std::max(1, static_cast<int>(std::ceil(std::sqrt(len2) / cell)));
            for (int st = 0; st <= steps; ++st) {
                auto c = cellOf(A + d * (static_cast<float>(st) / steps));
                for (long x = c[0] - 1; x <= c[0] + 1; ++x) for (long y = c[1] - 1; y <= c[1] + 1; ++y) for (long z = c[2] - 1; z <= c[2] + 1; ++z) {
                    uint64_t ck = key(x, y, z);
                    if (!visited.emplace(ck, 1).second) continue;
                    auto it = grid.find(ck);
                    if (it == grid.end()) continue;
                    for (uint32_t v : it->second) {
                        if (v == a || v == b) continue;
                        float s = (m.p[v] - A).dot(d) / len2;
                        if (s <= 1e-6f || s >= 1.0f - 1e-6f) continue;
                        if ((A + d * s - m.p[v]).length() <= eps) on.emplace_back(s, v);
                    }
                }
            }
        }
        std::sort(on.begin(), on.end());
        std::vector<uint32_t> ids;
        for (const auto& [s, v] : on) ids.push_back(v);
        inside.emplace(ek, std::move(ids));
    }

    std::vector<std::array<uint32_t, 3>> next;
    next.reserve(m.t.size());
    for (const auto& t : m.t) {
        // Points strictly inside each of the triangle's edges, in edge order. A vertex of this very
        // triangle cannot also split one of its edges (only a degenerate triangle could; cleanUp removes those).
        std::array<std::vector<uint32_t>, 3> on;
        size_t extra = 0;
        for (int k = 0; k < 3; ++k) {
            uint32_t a = t[k], b = t[(k + 1) % 3];
            std::vector<uint32_t> ids = inside[edgeKey(a, b)];
            if (a > b) std::reverse(ids.begin(), ids.end());
            for (uint32_t v : ids) if (v != t[0] && v != t[1] && v != t[2]) on[k].push_back(v);
            extra += on[k].size();
        }
        if (extra == 0) { next.push_back(t); continue; }
        splitTriangle(t[0], t[1], t[2], on[0], on[1], on[2], next);
    }
    m.t.swap(next);
}

// Removes what coplanar cuts leave behind: zero-area slivers (then re-splits their neighbours so
// no crack opens), zero-thickness fins (a triangle and its reverse twin) and same-facing duplicates.
// Repeats until stable.
inline void cleanUp(IndexedMesh& m, float eps) {
    for (int pass = 0; pass < 6; ++pass) {
        bool changed = false;
        std::vector<std::array<uint32_t, 3>> kept;
        kept.reserve(m.t.size());
        for (const auto& t : m.t) {
            if (t[0] == t[1] || t[1] == t[2] || t[0] == t[2]) { changed = true; continue; }
            // Degenerate when some corner lies within eps of the opposite edge: height = 2 area / longest edge.
            Vec3 n = (m.p[t[1]] - m.p[t[0]]).cross(m.p[t[2]] - m.p[t[0]]);
            float longest = 0.0f;
            for (int k = 0; k < 3; ++k) longest = std::max(longest, (m.p[t[k]] - m.p[t[(k + 1) % 3]]).length());
            if (longest <= 0.0f || n.length() / longest < eps * 0.5f) { changed = true; continue; }
            kept.push_back(t);
        }
        // Duplicates by vertex set; orientation decides fin (opposite) or plain duplicate (same).
        std::map<std::array<uint32_t, 3>, std::vector<size_t>> bySet;
        for (size_t i = 0; i < kept.size(); ++i) {
            auto k = kept[i];
            std::sort(k.begin(), k.end());
            bySet[k].push_back(i);
        }
        std::vector<char> drop(kept.size(), 0);
        auto parity = [](const std::array<uint32_t, 3>& t) {
            // Rotate so the smallest index leads; then the order of the other two is the orientation.
            int lead = t[0] < t[1] ? (t[0] < t[2] ? 0 : 2) : (t[1] < t[2] ? 1 : 2);
            return t[(lead + 1) % 3] < t[(lead + 2) % 3];
        };
        for (auto& [k, ids] : bySet) {
            if (ids.size() < 2) continue;
            int up = 0, down = 0;
            for (size_t i : ids) (parity(kept[i]) ? up : down)++;
            int keepUp = up > down ? up - down : 0, keepDown = down > up ? down - up : 0;
            keepUp = std::min(keepUp, 1); keepDown = std::min(keepDown, 1);
            for (size_t i : ids) {
                bool isUp = parity(kept[i]);
                if (isUp && keepUp > 0) { --keepUp; continue; }
                if (!isUp && keepDown > 0) { --keepDown; continue; }
                drop[i] = 1;
                changed = true;
            }
        }
        m.t.clear();
        for (size_t i = 0; i < kept.size(); ++i) if (!drop[i]) m.t.push_back(kept[i]);
        if (!changed) return;
        repairTJunctions(m, eps);
    }
}

// Turns exact CSG polygons into a welded triangle mesh using only exact decisions: vertices are merged
// when each lies on all three planes defining the other, a vertex is inserted into a polygon edge when it
// lies exactly on that edge's line (the support and edge planes) between its ends, and corners that are
// exactly collinear with their neighbours become edge points. Float positions only shortlist candidates.
inline IndexedMesh assembleExact(const std::vector<exact::Polygon>& polys, const Vec3& centre, double grid) {
    struct IV { exact::Plane p[3]; long double x[3]; };
    std::vector<IV> verts;
    std::vector<std::vector<uint32_t>> rings;             // per polygon: vertex ids in order
    std::vector<std::vector<std::pair<exact::Plane, exact::Plane>>> lines;  // per polygon edge: (support, edge plane)
    const long double tol = 1e-6L;                        // grid units; identical exact points agree to ~1e-12
    std::unordered_map<uint64_t, std::vector<uint32_t>> hash;
    auto key = [](long long x, long long y, long long z) {
        return (static_cast<uint64_t>(x & 0x1fffff) << 42) | (static_cast<uint64_t>(y & 0x1fffff) << 21) | static_cast<uint64_t>(z & 0x1fffff);
    };
    auto cellOf = [&](const long double x[3], long double cell) {
        return std::array<long long, 3>{ std::llround(std::floor(x[0] / cell)), std::llround(std::floor(x[1] / cell)), std::llround(std::floor(x[2] / cell)) };
    };
    auto onAll = [](const IV& v, const exact::Plane* planes) {
        for (int k = 0; k < 3; ++k) if (exact::orient(v.p[0], v.p[1], v.p[2], planes[k]) != 0) return false;
        return true;
    };
    auto intern = [&](const IV& v) -> uint32_t {
        auto c = cellOf(v.x, tol * 4);
        for (long long dx = -1; dx <= 1; ++dx) for (long long dy = -1; dy <= 1; ++dy) for (long long dz = -1; dz <= 1; ++dz) {
            auto it = hash.find(key(c[0] + dx, c[1] + dy, c[2] + dz));
            if (it == hash.end()) continue;
            for (uint32_t id : it->second) if (onAll(v, verts[id].p)) return id;
        }
        uint32_t id = static_cast<uint32_t>(verts.size());
        verts.push_back(v);
        hash[key(c[0], c[1], c[2])].push_back(id);
        return id;
    };
    for (const auto& poly : polys) {
        const size_t n = poly.e.size();
        std::vector<uint32_t> ring;
        std::vector<std::pair<exact::Plane, exact::Plane>> ln;
        for (size_t i = 0; i < n; ++i) {
            IV v;
            v.p[0] = poly.s; v.p[1] = poly.e[(i + n - 1) % n]; v.p[2] = poly.e[i];
            if (!exact::meet(v.p[0], v.p[1], v.p[2], v.x)) continue;
            uint32_t id = intern(v);
            if (!ring.empty() && ring.back() == id) { ln.back() = {poly.s, poly.e[i]}; continue; }
            ring.push_back(id);
            ln.push_back({poly.s, poly.e[i]});                 // edge from this vertex to the next lies on e[i]
        }
        while (ring.size() > 1 && ring.front() == ring.back()) { ring.pop_back(); ln.pop_back(); }
        rings.push_back(std::move(ring));
        lines.push_back(std::move(ln));
    }
    // Spatial index of all vertices for edge queries.
    long double cell = 0;
    {
        long double total = 0; size_t count = 0;
        for (const auto& r : rings) for (size_t i = 0; i < r.size(); ++i) {
            const auto& a = verts[r[i]].x; const auto& b = verts[r[(i + 1) % r.size()]].x;
            total += std::sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2])); ++count;
        }
        cell = std::max<long double>(1.0L, count ? total / count : 1.0L);
    }
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid2;
    for (uint32_t i = 0; i < verts.size(); ++i) { auto c = cellOf(verts[i].x, cell); grid2[key(c[0], c[1], c[2])].push_back(i); }
    auto pointsOn = [&](uint32_t a, uint32_t b, const exact::Plane& sp, const exact::Plane& ep) {
        const auto& A = verts[a].x; const auto& B = verts[b].x;
        long double d[3] = {B[0] - A[0], B[1] - A[1], B[2] - A[2]};
        long double len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        std::vector<std::pair<long double, uint32_t>> on;
        if (len2 <= 0) return on;
        int steps = std::max(1, static_cast<int>(std::ceil(std::sqrt(len2) / cell)));
        std::unordered_map<uint64_t, char> seen;
        for (int st = 0; st <= steps; ++st) {
            long double q[3] = {A[0] + d[0] * st / steps, A[1] + d[1] * st / steps, A[2] + d[2] * st / steps};
            auto c = cellOf(q, cell);
            for (long long dx = -1; dx <= 1; ++dx) for (long long dy = -1; dy <= 1; ++dy) for (long long dz = -1; dz <= 1; ++dz) {
                uint64_t k = key(c[0] + dx, c[1] + dy, c[2] + dz);
                if (!seen.emplace(k, 1).second) continue;
                auto it = grid2.find(k);
                if (it == grid2.end()) continue;
                for (uint32_t v : it->second) {
                    if (v == a || v == b) continue;
                    const auto& P = verts[v].x;
                    long double t = ((P[0] - A[0]) * d[0] + (P[1] - A[1]) * d[1] + (P[2] - A[2]) * d[2]) / len2;
                    if (t <= 0 || t >= 1) continue;
                    long double off[3] = {A[0] + d[0] * t - P[0], A[1] + d[1] * t - P[1], A[2] + d[2] * t - P[2]};
                    if (off[0] * off[0] + off[1] * off[1] + off[2] * off[2] > 1e-6L) continue;   // shortlist only
                    const IV& iv = verts[v];
                    if (exact::orient(iv.p[0], iv.p[1], iv.p[2], sp) == 0 && exact::orient(iv.p[0], iv.p[1], iv.p[2], ep) == 0) on.emplace_back(t, v);
                }
            }
        }
        std::sort(on.begin(), on.end());
        return on;
    };
    IndexedMesh out;
    // Output positions are float: exact points closer than float precision become one vertex here (an edge
    // collapse; triangles it degenerates are dropped below), so the mesh handed on is the one validated.
    std::vector<uint32_t> floatId(verts.size());
    {
        std::map<std::array<float, 3>, uint32_t> byPos;
        for (size_t i = 0; i < verts.size(); ++i) {
            std::array<float, 3> q = { static_cast<float>(centre.x + verts[i].x[0] * grid), static_cast<float>(centre.y + verts[i].x[1] * grid),
                                       static_cast<float>(centre.z + verts[i].x[2] * grid) };
            auto it = byPos.find(q);
            if (it == byPos.end()) { it = byPos.emplace(q, static_cast<uint32_t>(out.p.size())).first; out.p.push_back(Vec3(q[0], q[1], q[2])); }
            floatId[i] = it->second;
        }
    }
    for (size_t pi = 0; pi < rings.size(); ++pi) {
        const auto& ring = rings[pi];
        const auto& ln = lines[pi];
        const size_t n = ring.size();
        if (n < 3) continue;
        // Points inside each edge, then fold exactly collinear corners into the edge before them.
        std::vector<std::vector<uint32_t>> inside(n);
        for (size_t i = 0; i < n; ++i) for (auto& [t, v] : pointsOn(ring[i], ring[(i + 1) % n], ln[i].first, ln[i].second)) inside[i].push_back(v);
        std::vector<uint32_t> corners;
        std::vector<std::vector<uint32_t>> edgePts;
        for (size_t i = 0; i < n; ++i) {
            size_t prev = (i + n - 1) % n;
            const IV& vi = verts[ring[i]];
            // vi is a true corner unless the next vertex also lies on the previous edge's line.
            const IV& vn = verts[ring[(i + 1) % n]];
            bool straight = exact::orient(vn.p[0], vn.p[1], vn.p[2], ln[prev].second) == 0;
            (void)vi;
            if (straight && !corners.empty()) {
                edgePts.back().push_back(ring[i]);
                edgePts.back().insert(edgePts.back().end(), inside[i].begin(), inside[i].end());
                continue;
            }
            corners.push_back(ring[i]);
            edgePts.push_back(inside[i]);
        }
        // A straight run that wrapped past the start belongs to the last edge.
        if (corners.size() >= 2) {
            size_t i0 = 0;
            const IV& vn = verts[ring[1 % n]];
            bool firstStraight = exact::orient(vn.p[0], vn.p[1], vn.p[2], ln[n - 1].second) == 0;
            if (firstStraight) {
                edgePts.back().push_back(corners[i0]);
                edgePts.back().insert(edgePts.back().end(), edgePts[0].begin(), edgePts[0].end());
                corners.erase(corners.begin());
                edgePts.erase(edgePts.begin());
            }
        }
        const size_t m = corners.size();
        if (m < 3) continue;
        static const std::vector<uint32_t> none;
        for (size_t i = 1; i + 1 < m; ++i) {
            splitTriangle(corners[0], corners[i], corners[i + 1], i == 1 ? edgePts[0] : none, edgePts[i],
                          i + 2 == m ? edgePts[m - 1] : none, out.t);
        }
    }
    std::vector<std::array<uint32_t, 3>> kept;
    kept.reserve(out.t.size());
    for (auto t : out.t) {
        for (auto& v : t) v = floatId[v];
        if (t[0] != t[1] && t[1] != t[2] && t[0] != t[2]) kept.push_back(t);
    }
    // A collapse can fold two triangles onto each other: opposite twins (zero-thickness fins) cancel and
    // same-facing duplicates keep one copy. Purely topological, no tolerances.
    auto parity = [](const std::array<uint32_t, 3>& t) {
        int lead = t[0] < t[1] ? (t[0] < t[2] ? 0 : 2) : (t[1] < t[2] ? 1 : 2);
        return t[(lead + 1) % 3] < t[(lead + 2) % 3];
    };
    std::map<std::array<uint32_t, 3>, std::pair<std::vector<size_t>, std::vector<size_t>>> bySet;
    for (size_t i = 0; i < kept.size(); ++i) {
        auto k = kept[i];
        std::sort(k.begin(), k.end());
        (parity(kept[i]) ? bySet[k].first : bySet[k].second).push_back(i);
    }
    std::vector<char> drop(kept.size(), 0);
    for (auto& [k, groups] : bySet) {
        auto& [up, down] = groups;
        if (up.size() + down.size() < 2) continue;
        size_t keepUp = up.size() > down.size() ? 1 : 0, keepDown = down.size() > up.size() ? 1 : 0;
        for (size_t i = keepUp; i < up.size(); ++i) drop[up[i]] = 1;
        for (size_t i = keepDown; i < down.size(); ++i) drop[down[i]] = 1;
    }
    out.t.clear();
    for (size_t i = 0; i < kept.size(); ++i) if (!drop[i]) out.t.push_back(kept[i]);
    return out;
}

// Re-triangulates each flat region (coplanar, edge-connected faces) from its boundary loops alone,
// so the slivers and fan hubs that splitting and T-junction repair leave behind do not pile up when
// booleans are chained. Every boundary vertex is kept, so neighbouring regions still match. A region
// whose boundary is ambiguous or whose new triangulation does not check out keeps its faces.
inline void regularizeFlatRegions(IndexedMesh& m, float eps) {
    const size_t F = m.t.size();
    if (F == 0) return;
    std::vector<Vec3> fn(F);
    for (size_t f = 0; f < F; ++f) fn[f] = faceNormal(m, f);
    auto ef = edgeFaces(m);
    std::vector<int> region(F, -1);
    std::vector<std::vector<uint32_t>> regions;
    for (size_t s = 0; s < F; ++s) {
        if (region[s] >= 0) continue;
        const Vec3 n0 = fn[s];
        const float d0 = n0.dot(m.p[m.t[s][0]]);
        std::vector<uint32_t> faces{static_cast<uint32_t>(s)}, stack{static_cast<uint32_t>(s)};
        region[s] = static_cast<int>(regions.size());
        while (!stack.empty()) {
            uint32_t f = stack.back(); stack.pop_back();
            for (int k = 0; k < 3; ++k) {
                const auto& fs = ef.at(edgeKey(m.t[f][k], m.t[f][(k + 1) % 3]));
                if (fs.size() != 2) continue;
                for (uint32_t g : fs) {
                    if (region[g] >= 0 || fn[g].dot(n0) < 0.999999f) continue;
                    bool onPlane = true;
                    for (uint32_t v : m.t[g]) if (std::abs(n0.dot(m.p[v]) - d0) > eps) onPlane = false;
                    if (!onPlane) continue;
                    region[g] = region[s];
                    faces.push_back(g); stack.push_back(g);
                }
            }
        }
        regions.push_back(std::move(faces));
    }
    std::vector<std::array<uint32_t, 3>> out;
    out.reserve(F);
    for (const auto& faces : regions) {
        auto keep = [&] { for (uint32_t f : faces) out.push_back(m.t[f]); };
        if (faces.size() < 3) { keep(); continue; }
        int r = region[faces[0]];
        // Boundary edges, directed as in the region's faces.
        std::unordered_map<uint32_t, uint32_t> nextOf;
        bool ambiguous = false;
        size_t boundaryCount = 0;
        for (uint32_t f : faces) for (int k = 0; k < 3; ++k) {
            uint32_t a = m.t[f][k], b = m.t[f][(k + 1) % 3];
            const auto& fs = ef.at(edgeKey(a, b));
            bool inner = false;
            for (uint32_t g : fs) if (g != f && region[g] == r) inner = true;
            if (inner) continue;
            if (!nextOf.emplace(a, b).second) ambiguous = true;
            ++boundaryCount;
        }
        if (ambiguous || boundaryCount < 3) { keep(); continue; }
        std::vector<std::vector<uint32_t>> loops;
        std::unordered_map<uint32_t, char> used;
        for (const auto& [startV, nv] : nextOf) {
            if (used.count(startV)) continue;
            std::vector<uint32_t> loop;
            uint32_t cur = startV;
            while (!used.count(cur)) {
                used[cur] = 1; loop.push_back(cur);
                auto it = nextOf.find(cur);
                if (it == nextOf.end()) { ambiguous = true; break; }
                cur = it->second;
            }
            if (cur != startV) ambiguous = true;
            loops.push_back(std::move(loop));
        }
        if (ambiguous) { keep(); continue; }
        // 2D frame with (u x v) along the region normal, so counter-clockwise loops face the right way.
        Vec3 n(0, 0, 0);
        for (uint32_t f : faces) n += (m.p[m.t[f][1]] - m.p[m.t[f][0]]).cross(m.p[m.t[f][2]] - m.p[m.t[f][0]]);
        n = n.normalized();
        Vec3 u = std::abs(n.x) < 0.9f ? Vec3(1, 0, 0).cross(n).normalized() : Vec3(0, 1, 0).cross(n).normalized();
        Vec3 v = n.cross(u);
        std::vector<std::vector<scan_geom::P2>> polys;
        std::map<std::pair<double, double>, uint32_t> idOf;
        size_t outerIdx = 0; double outerArea = -1.0;
        for (size_t li = 0; li < loops.size(); ++li) {
            std::vector<scan_geom::P2> poly;
            for (uint32_t id : loops[li]) {
                scan_geom::P2 q(static_cast<double>(m.p[id].dot(u)), static_cast<double>(m.p[id].dot(v)));
                poly.push_back(q);
                idOf[{q.x, q.y}] = id;
            }
            double area = scan_geom::signedArea(poly);
            if (area > outerArea) { outerArea = area; outerIdx = li; }
            polys.push_back(std::move(poly));
        }
        if (idOf.size() != nextOf.size() || outerArea <= 0.0) { keep(); continue; }
        std::vector<std::vector<scan_geom::P2>> holes;
        for (size_t li = 0; li < polys.size(); ++li) if (li != outerIdx) holes.push_back(polys[li]);
        std::vector<scan_geom::P2> verts;
        std::vector<uint32_t> tri = scan_geom::triangulate(polys[outerIdx], holes, verts);
        size_t expected = nextOf.size() + 2 * holes.size() - 2;
        bool ok = tri.size() == expected * 3;
        std::vector<std::array<uint32_t, 3>> fresh;
        for (size_t i = 0; ok && i + 2 < tri.size(); i += 3) {
            std::array<uint32_t, 3> t3;
            for (int k = 0; k < 3; ++k) {
                auto it = idOf.find({verts[tri[i + k]].x, verts[tri[i + k]].y});
                if (it == idOf.end()) { ok = false; break; }
                t3[k] = it->second;
            }
            if (!ok) break;
            Vec3 tn = (m.p[t3[1]] - m.p[t3[0]]).cross(m.p[t3[2]] - m.p[t3[0]]);
            if (tn.dot(n) <= 0.0f) { ok = false; break; }
            fresh.push_back(t3);
        }
        if (!ok) { keep(); continue; }
        out.insert(out.end(), fresh.begin(), fresh.end());
    }
    m.t.swap(out);
}

// Exact booleans work on one fixed integer grid (2^-24 m, about 60 nm) with coordinates of up to 40 bits
// (+-65 km), so exact results from one boolean can be reused unchanged by the next.
constexpr double kExactQuantum = 1.0 / 16777216.0;
constexpr int64_t kExactLimit = int64_t(1) << 40;

// Exact polygons of recent boolean results, keyed by a hash of the mesh each one returned. A later boolean
// given exactly that mesh (bit for bit) continues from its exact polygons instead of re-snapping floats,
// so chains of booleans stay exact; any change to the mesh (moving, bevelling, editing) changes the hash.
struct ExactCache {
    std::mutex lock;
    std::vector<std::pair<uint64_t, std::shared_ptr<const std::vector<exact::Polygon>>>> entries;  // most recent last
    static ExactCache& instance() { static ExactCache c; return c; }
};

inline uint64_t meshHash(const ScratchboxMesh& m) {
    uint64_t h = 1469598103934665603ull;
    auto mix = [&](uint64_t v) { for (int i = 0; i < 8; ++i) { h ^= (v >> (i * 8)) & 0xff; h *= 1099511628211ull; } };
    mix(m.vertices.size()); mix(m.indices.size());
    for (const auto& v : m.vertices) {
        uint32_t bits[3];
        std::memcpy(&bits[0], &v.position.x, 4); std::memcpy(&bits[1], &v.position.y, 4); std::memcpy(&bits[2], &v.position.z, 4);
        mix((static_cast<uint64_t>(bits[0]) << 32) | bits[1]); mix(bits[2]);
    }
    for (uint32_t i : m.indices) mix(i);
    return h;
}

inline std::shared_ptr<const std::vector<exact::Polygon>> cachedExact(const ScratchboxMesh& m) {
    uint64_t h = meshHash(m);
    auto& c = ExactCache::instance();
    std::lock_guard<std::mutex> g(c.lock);
    for (auto it = c.entries.rbegin(); it != c.entries.rend(); ++it) if (it->first == h) return it->second;
    return nullptr;
}

inline void rememberExact(const ScratchboxMesh& m, std::vector<exact::Polygon> polys) {
    uint64_t h = meshHash(m);
    auto& c = ExactCache::instance();
    std::lock_guard<std::mutex> g(c.lock);
    c.entries.emplace_back(h, std::make_shared<const std::vector<exact::Polygon>>(std::move(polys)));
    if (c.entries.size() > 32) c.entries.erase(c.entries.begin());
}

// A closed triangle mesh as exact polygons on the fixed grid.
inline std::vector<exact::Polygon> snapToExact(const ScratchboxMesh& mesh) {
    // Exact-position weld first (shared vertices are bit-for-bit equal, as in chained results); the usual
    // relative weld only for inputs that are not closed that way (seam copies differing by rounding noise).
    auto closedMesh = [](const IndexedMesh& m) { for (const auto& [k, fs] : edgeFaces(m)) if (fs.size() != 2) return false; return true; };
    IndexedMesh w = weldExact(mesh);
    if (!closedMesh(w)) w = weld(mesh);
    if (!closedMesh(w)) throw std::invalid_argument("mesh boolean needs closed inputs: '" + mesh.name + "' has open or over-shared edges");
    auto snap = [&](const Vec3& q) {
        std::array<int64_t, 3> r = { std::llround(q.x / kExactQuantum), std::llround(q.y / kExactQuantum), std::llround(q.z / kExactQuantum) };
        for (int64_t c : r) if (c >= kExactLimit || c <= -kExactLimit) throw std::invalid_argument("mesh boolean: coordinates beyond +-65 km from the origin");
        return r;
    };
    std::vector<exact::Polygon> polys;
    for (const auto& t : w.t) {
        std::array<int64_t, 3> v[3] = { snap(w.p[t[0]]), snap(w.p[t[1]]), snap(w.p[t[2]]) };
        __int128 e1[3], e2[3];
        for (int k = 0; k < 3; ++k) { e1[k] = v[1][k] - v[0][k]; e2[k] = v[2][k] - v[0][k]; }
        exact::Plane sp{ e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0], 0 };
        if (sp.a == 0 && sp.b == 0 && sp.c == 0) continue;  // collapsed by snapping: an edge collapse of the closed input
        sp.d = -(sp.a * v[0][0] + sp.b * v[0][1] + sp.c * v[0][2]);
        // Bounding plane of each edge: contains the edge and the axis the face most faces, so it is never
        // parallel to the face and its coefficients stay small.
        auto mag = [](__int128 x) { return x < 0 ? -x : x; };
        int axis = mag(sp.a) >= mag(sp.b) && mag(sp.a) >= mag(sp.c) ? 0 : (mag(sp.b) >= mag(sp.c) ? 1 : 2);
        exact::Polygon poly;
        poly.s = sp;
        for (int k = 0; k < 3; ++k) {
            const auto& a0 = v[k]; const auto& a1 = v[(k + 1) % 3]; const auto& opp = v[(k + 2) % 3];
            __int128 d[3] = { a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2] };
            __int128 ax[3] = {0, 0, 0}; ax[axis] = 1;
            exact::Plane ep{ d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0], 0 };
            ep.d = -(ep.a * a0[0] + ep.b * a0[1] + ep.c * a0[2]);
            __int128 atOpp = ep.a * opp[0] + ep.b * opp[1] + ep.c * opp[2] + ep.d;
            if (atOpp > 0) ep = ep.flipped();
            poly.e.push_back(ep);
        }
        polys.push_back(std::move(poly));
    }
    return polys;
}

inline std::vector<exact::Polygon> booleanPolygons(const ScratchboxMesh& a, const ScratchboxMesh& b, BooleanKind kind) {
    auto exactOf = [](const ScratchboxMesh& m) {
        if (auto hit = cachedExact(m)) return *hit;
        return snapToExact(m);
    };
    exact::Bsp A, B;
    A.build(exactOf(a));
    B.build(exactOf(b));
    switch (kind) {
        case BooleanKind::Union:
            A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.allPolygons());
            break;
        case BooleanKind::Subtract:
            A.invert(); A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.allPolygons()); A.invert();
            break;
        case BooleanKind::Intersect:
            A.invert(); B.clipTo(A); B.invert(); A.clipTo(B); B.clipTo(A); A.build(B.allPolygons()); A.invert();
            break;
    }
    return A.allPolygons();
}

inline ScratchboxMesh booleanOp(const ScratchboxMesh& a, const ScratchboxMesh& b, BooleanKind kind,
                                float smoothAngleDeg = 30.0f, const std::string& name = "Boolean", bool requireClosed = true) {
    auto polys = booleanPolygons(a, b, kind);
    IndexedMesh out = assembleExact(polys, Vec3(0, 0, 0), kExactQuantum);
    auto closed = [](const IndexedMesh& m) { for (const auto& [k, fs] : edgeFaces(m)) if (fs.size() != 2) return false; return true; };
    if (closed(out)) {
        // The tidy-up is kept only when it keeps the result closed (it judges flatness in floats).
        IndexedMesh tidy = out;
        regularizeFlatRegions(tidy, static_cast<float>(kExactQuantum * 4.0));
        if (closed(tidy)) out.t.swap(tidy.t);
    }
    size_t open = 0, overShared = 0;
    for (const auto& [k, fs] : edgeFaces(out)) {
        if (fs.size() == 1) ++open;
        else if (fs.size() > 2) ++overShared;
    }
    if (requireClosed && (open || overShared)) {
        throw std::runtime_error("boolean result is not closed (" + std::to_string(open) + " open and " + std::to_string(overShared) +
            " over-shared edges). Booleans are exact on closed inputs; check both inputs are closed solids with consistent "
            "outward winding, or pass require_closed=False to inspect the result");
    }
    ScratchboxMesh result = finish(out, a, name, smoothAngleDeg);
    rememberExact(result, std::move(polys));
    return result;
}

// Collapses edges shorter than minLen on a closed manifold, keeping it closed: an edge collapses only when
// its endpoints share exactly the two neighbours of its two faces (the link condition) and no surrounding
// face would flip. The surviving point is the endpoint on more sharp edges (corners stay put), else the
// midpoint. Removes the micro-edges exact booleans keep where features nearly meet.
inline void collapseShortEdges(IndexedMesh& m, float minLen, float sharpAngleDeg) {
    if (minLen <= 0.0f || m.t.empty()) return;
    const float cosSharp = std::cos(sharpAngleDeg * math::DEG_TO_RAD);
    for (int pass = 0; pass < 8; ++pass) {
        std::vector<std::vector<uint32_t>> vf(m.p.size());
        for (uint32_t f = 0; f < m.t.size(); ++f) for (uint32_t v : m.t[f]) vf[v].push_back(f);
        std::vector<char> deadF(m.t.size(), 0), touched(m.p.size(), 0);
        auto normal = [&](const std::array<uint32_t, 3>& t, const std::vector<Vec3>& P) {
            return (P[t[1]] - P[t[0]]).cross(P[t[2]] - P[t[0]]);
        };
        auto ef = edgeFaces(m);
        std::vector<int> sharpCount(m.p.size(), 0);
        for (const auto& [k, fs] : ef) {
            if (fs.size() != 2) continue;
            if (faceNormal(m, fs[0]).dot(faceNormal(m, fs[1])) < cosSharp) { ++sharpCount[k >> 32]; ++sharpCount[k & 0xffffffffu]; }
        }
        std::vector<std::pair<float, uint64_t>> shortEdges;
        for (const auto& [k, fs] : ef) {
            float len = (m.p[k >> 32] - m.p[k & 0xffffffffu]).length();
            if (len < minLen && fs.size() == 2) shortEdges.emplace_back(len, k);
        }
        if (shortEdges.empty()) return;
        std::sort(shortEdges.begin(), shortEdges.end());
        bool changed = false;
        for (const auto& [len, k] : shortEdges) {
            uint32_t a = static_cast<uint32_t>(k >> 32), b = static_cast<uint32_t>(k & 0xffffffffu);
            if (touched[a] || touched[b]) continue;
            // Faces on the edge, and neighbour sets for the link condition.
            std::vector<uint32_t> both;
            std::set<uint32_t> na, nb;
            for (uint32_t f : vf[a]) if (!deadF[f]) for (uint32_t v : m.t[f]) if (v != a) na.insert(v);
            for (uint32_t f : vf[b]) if (!deadF[f]) for (uint32_t v : m.t[f]) if (v != b) nb.insert(v);
            for (uint32_t f : vf[a]) if (!deadF[f] && (m.t[f][0] == b || m.t[f][1] == b || m.t[f][2] == b)) both.push_back(f);
            if (both.size() != 2) continue;
            size_t common = 0;
            for (uint32_t v : na) if (v != b && nb.count(v)) ++common;
            if (common != 2) continue;
            Vec3 target = sharpCount[a] > sharpCount[b] ? m.p[a] : (sharpCount[b] > sharpCount[a] ? m.p[b] : (m.p[a] + m.p[b]) * 0.5f);
            // No surrounding face may flip.
            std::vector<Vec3> P = m.p;
            P[a] = target; P[b] = target;
            bool flips = false;
            for (uint32_t v : {a, b}) for (uint32_t f : vf[v]) {
                if (deadF[f] || f == both[0] || f == both[1]) continue;
                Vec3 before = normal(m.t[f], m.p), after = normal(m.t[f], P);
                if (before.dot(after) <= 0.0f) { flips = true; break; }
            }
            if (flips) continue;
            m.p[a] = target;
            for (uint32_t f : vf[b]) {
                if (deadF[f]) continue;
                for (auto& v : m.t[f]) if (v == b) v = a;
            }
            deadF[both[0]] = deadF[both[1]] = 1;
            for (uint32_t f : vf[a]) if (!deadF[f]) for (uint32_t v : m.t[f]) touched[v] = 1;
            for (uint32_t f : vf[b]) if (!deadF[f]) for (uint32_t v : m.t[f]) touched[v] = 1;
            changed = true;
        }
        std::vector<std::array<uint32_t, 3>> kept;
        for (size_t f = 0; f < m.t.size(); ++f) if (!deadF[f]) kept.push_back(m.t[f]);
        m.t.swap(kept);
        if (!changed) return;
    }
}

// --------------------------------------------------------------------------
// Bevel
// --------------------------------------------------------------------------
inline ScratchboxMesh bevel(const ScratchboxMesh& input, float width, int segments = 1, float sharpAngleDeg = 30.0f,
                            float smoothAngleDeg = 30.0f, const std::string& name = "Beveled") {
    IndexedMesh m = weldForOps(input);
    if (m.t.empty() || width <= 0.0f) return finish(m, input, name, smoothAngleDeg);
    if (badEdges(m) == 0) collapseShortEdges(m, width * 0.25f, sharpAngleDeg);
    const size_t F = m.t.size();
    std::vector<Vec3> fn(F);
    for (size_t f = 0; f < F; ++f) fn[f] = faceNormal(m, f);
    auto ef = edgeFaces(m);
    const float cosSharp = std::cos(sharpAngleDeg * math::DEG_TO_RAD);
    for (const auto& [k, fs] : ef) if (fs.size() != 2) throw std::invalid_argument("bevel needs a closed 2-manifold mesh (every edge shared by exactly two faces)");
    // Slivers (cut debris, thin fans) have unreliable normals. A sliver comes from nearly collinear
    // points of one planar polygon, so it takes the normal of the face across its longest edge
    // (following up to a few slivers in a row).
    std::vector<char> sliver(F, 0);
    std::vector<int> longEdge(F, 0);
    for (size_t f = 0; f < F; ++f) {
        const auto& t = m.t[f];
        float longest = 0.0f;
        for (int k = 0; k < 3; ++k) {
            float l = (m.p[t[k]] - m.p[t[(k + 1) % 3]]).length();
            if (l > longest) { longest = l; longEdge[f] = k; }
        }
        float area2 = (m.p[t[1]] - m.p[t[0]]).cross(m.p[t[2]] - m.p[t[0]]).length();
        sliver[f] = area2 < 2e-3f * longest * longest;
    }
    {
        std::vector<Vec3> settled = fn;
        for (size_t f = 0; f < F; ++f) {
            if (!sliver[f]) continue;
            uint32_t cur = static_cast<uint32_t>(f);
            for (int hop = 0; hop < 6 && sliver[cur]; ++hop) {
                const auto& t = m.t[cur];
                const auto& fs = ef.at(edgeKey(t[longEdge[cur]], t[(longEdge[cur] + 1) % 3]));
                uint32_t across = fs[0] == cur ? fs[1] : fs[0];
                if (across == f) break;
                cur = across;
            }
            if (!sliver[cur]) settled[f] = fn[cur];
        }
        fn.swap(settled);
    }
    auto sharp = [&](uint32_t a, uint32_t b) {
        const auto& fs = ef.at(edgeKey(a, b));
        return fn[fs[0]].dot(fn[fs[1]]) < cosSharp;
    };

    // Smooth regions: faces connected across non-sharp edges.
    std::vector<int> region(F, -1);
    int regionCount = 0;
    for (size_t s = 0; s < F; ++s) {
        if (region[s] >= 0) continue;
        std::vector<uint32_t> stack{static_cast<uint32_t>(s)};
        region[s] = regionCount;
        while (!stack.empty()) {
            uint32_t f = stack.back(); stack.pop_back();
            for (int k = 0; k < 3; ++k) {
                uint32_t a = m.t[f][k], b = m.t[f][(k + 1) % 3];
                if (sharp(a, b)) continue;
                for (uint32_t g : ef.at(edgeKey(a, b))) if (region[g] < 0) { region[g] = regionCount; stack.push_back(g); }
            }
        }
        ++regionCount;
    }

    // Each (vertex, region) pair on a sharp edge gets its own copy, pulled into the region.
    std::vector<std::vector<uint32_t>> vf(m.p.size());
    for (size_t f = 0; f < F; ++f) for (uint32_t v : m.t[f]) vf[v].push_back(static_cast<uint32_t>(f));
    // Shortest edge at each vertex limits the width so faces cannot invert.
    std::vector<float> shortest(m.p.size(), 1e30f);
    for (const auto& t : m.t) for (int k = 0; k < 3; ++k) {
        float l = (m.p[t[k]] - m.p[t[(k + 1) % 3]]).length();
        shortest[t[k]] = std::min(shortest[t[k]], l); shortest[t[(k + 1) % 3]] = std::min(shortest[t[(k + 1) % 3]], l);
    }
    std::map<std::pair<uint32_t, int>, uint32_t> copyOf;
    IndexedMesh out;
    out.p = m.p;
    auto copyFor = [&](uint32_t v, int r) -> uint32_t {
        auto key = std::make_pair(v, r);
        auto it = copyOf.find(key);
        if (it != copyOf.end()) return it->second;
        // Sharp edges at v bordering region r, and the region's normal at v.
        Vec3 nR(0, 0, 0);
        std::vector<Vec3> inward;
        for (uint32_t f : vf[v]) {
            if (region[f] != r) continue;
            nR += fn[f];
            for (int k = 0; k < 3; ++k) {
                uint32_t a = m.t[f][k], b = m.t[f][(k + 1) % 3];
                if ((a != v && b != v) || !sharp(a, b)) continue;
                uint32_t o = a == v ? b : a;
                Vec3 d = (m.p[o] - m.p[v]).normalized();
                uint32_t third = m.t[f][(k + 2) % 3];
                Vec3 into = m.p[third] - m.p[v];
                Vec3 perp = (into - d * into.dot(d));
                if (perp.length() > 1e-12f) inward.push_back(perp.normalized());
            }
        }
        uint32_t idx = v;
        if (!inward.empty()) {
            nR = nR.normalized();
            Vec3 dir(0, 0, 0);
            // Mitre: for two edges the offset point satisfies dot(x, p_i) = 1 for both perpendiculars.
            if (inward.size() >= 2) {
                Vec3 p1 = inward[0], p2 = inward[1];
                float c = p1.dot(p2);
                dir = (p1 + p2) * (1.0f / std::max(0.2f, 1.0f + c));
            } else {
                dir = inward[0];
            }
            dir = dir - nR * dir.dot(nR);
            float w = std::min(width, shortest[v] * 0.45f);
            idx = static_cast<uint32_t>(out.p.size());
            out.p.push_back(m.p[v] + dir * w);
        }
        copyOf.emplace(key, idx);
        return idx;
    };
    // Region faces, rewired to their copies.
    for (size_t f = 0; f < F; ++f) {
        std::array<uint32_t, 3> t;
        for (int k = 0; k < 3; ++k) t[k] = copyFor(m.t[f][k], region[f]);
        out.t.push_back(t);
    }
    // Profile point between copy A (region a) and copy B (region b) of the original vertex v.
    // Rounded profile points are shared by every strip ending at the same (vertex, copy pair), so strips
    // meeting at a vertex without a corner cap (a rim) join without cracks; the reverse direction maps to
    // the same points.
    std::map<std::tuple<uint32_t, uint32_t, uint32_t, int>, uint32_t> profilePoint;
    auto profile = [&](uint32_t v, uint32_t ca, uint32_t cb, int s) -> uint32_t {
        if (s == 0) return ca;
        if (s == segments) return cb;
        if (ca > cb) { std::swap(ca, cb); s = segments - s; }
        auto key = std::make_tuple(v, ca, cb, s);
        auto it = profilePoint.find(key);
        if (it != profilePoint.end()) return it->second;
        float t = static_cast<float>(s) / segments;
        Vec3 A = out.p[ca], B = out.p[cb], V = m.p[v];
        // Quadratic Bezier with the original corner as control: a rounded fillet section.
        Vec3 q = A * ((1 - t) * (1 - t)) + V * (2 * t * (1 - t)) + B * (t * t);
        out.p.push_back(q);
        uint32_t id = static_cast<uint32_t>(out.p.size() - 1);
        profilePoint.emplace(key, id);
        return id;
    };
    // Strips along sharp edges; remember each strip end's profile for the corner caps.
    // (v, o) -> the strip's end profile at v, running from the copy in the region of the face where the
    // edge runs v->o to the copy in the other face's region.
    std::map<std::pair<uint32_t, uint32_t>, std::vector<uint32_t>> endProfile;
    for (const auto& [k, fs] : ef) {
        uint32_t a = static_cast<uint32_t>(k >> 32), b = static_cast<uint32_t>(k & 0xffffffffu);
        if (!sharp(a, b)) continue;
        uint32_t fA = fs[0], fB = fs[1];
        // Orient along fA's winding: fA has a->b.
        for (int i = 0; i < 3; ++i) if (m.t[fA][i] == b && m.t[fA][(i + 1) % 3] == a) std::swap(a, b);
        std::vector<uint32_t> pa(segments + 1), pb(segments + 1);
        for (int s = 0; s <= segments; ++s) {
            pa[s] = profile(a, copyFor(a, region[fA]), copyFor(a, region[fB]), s);
            pb[s] = profile(b, copyFor(b, region[fA]), copyFor(b, region[fB]), s);
        }
        for (int s = 0; s < segments; ++s) {
            // Quad (b_s, a_s, a_s+1, b_s+1) continues fA's winding across the edge.
            out.t.push_back({pb[s], pa[s], pa[s + 1]});
            out.t.push_back({pb[s], pa[s + 1], pb[s + 1]});
        }
        endProfile[{a, b}] = pa;                                         // fA runs a->b: from fA's copy
        endProfile[{b, a}] = std::vector<uint32_t>(pb.rbegin(), pb.rend());  // fB runs b->a: from fB's copy
    }
    // Corner caps: walk the faces around each vertex in winding order and, at every sharp edge crossed,
    // append that strip's end profile (it runs from the copy of the face being left to the copy of the
    // face being entered). The loop closes by construction, even where one region meets the vertex in
    // two separate sectors; it is then fanned from a hub pulled towards the original corner.
    for (uint32_t v = 0; v < m.p.size(); ++v) {
        int sharpAround = 0;
        for (uint32_t f : vf[v]) for (int k = 0; k < 3; ++k) if (m.t[f][k] == v && sharp(v, m.t[f][(k + 1) % 3])) ++sharpAround;
        if (sharpAround < 3) continue;
        std::vector<uint32_t> loop;
        uint32_t f0 = vf[v][0], f = f0;
        bool ok = true;
        for (size_t guard = 0; guard <= vf[v].size(); ++guard) {
            int k = -1;
            for (int i = 0; i < 3; ++i) if (m.t[f][i] == v) k = i;
            if (k < 0) { ok = false; break; }
            uint32_t o = m.t[f][(k + 1) % 3];            // f's winding runs v -> o on this edge
            const auto& fs = ef.at(edgeKey(v, o));
            uint32_t g = fs[0] == f ? fs[1] : fs[0];
            if (sharp(v, o)) {
                auto it = endProfile.find({v, o});
                if (it == endProfile.end()) { ok = false; break; }
                loop.insert(loop.end(), it->second.begin(), it->second.end() - 1);
            }
            f = g;
            if (f == f0) break;
        }
        if (!ok || f != f0 || loop.size() < 3) continue;
        Vec3 c(0, 0, 0);
        for (uint32_t q : loop) c += out.p[q];
        c = c / static_cast<float>(loop.size());
        if (segments > 1) c = c + (m.p[v] - c) * 0.5f;
        uint32_t hub = static_cast<uint32_t>(out.p.size());
        out.p.push_back(c);
        Vec3 outward = m.p[v] - c;
        for (size_t i = 0; i < loop.size(); ++i) {
            uint32_t x = loop[i], y = loop[(i + 1) % loop.size()];
            if (x == y) continue;
            Vec3 n = (out.p[x] - out.p[hub]).cross(out.p[y] - out.p[hub]);
            if (n.dot(outward) >= 0) out.t.push_back({hub, x, y});
            else out.t.push_back({hub, y, x});
        }
    }
    return finish(out, input, name, smoothAngleDeg);
}

// --------------------------------------------------------------------------
// Inset / extrude
// --------------------------------------------------------------------------
inline ScratchboxMesh insetExtrude(const ScratchboxMesh& input, const Vec3& facing, float maxAngleDeg, float inset, float depth,
                                   const Vec3& boxMin, const Vec3& boxMax, bool useBox, float smoothAngleDeg = 30.0f,
                                   const std::string& name = "InsetExtruded") {
    IndexedMesh m = weldForOps(input);
    const size_t F = m.t.size();
    std::vector<Vec3> fn(F);
    for (size_t f = 0; f < F; ++f) fn[f] = faceNormal(m, f);
    const Vec3 dir = facing.normalized();
    const float cosMax = std::cos(maxAngleDeg * math::DEG_TO_RAD);
    std::vector<char> sel(F, 0);
    for (size_t f = 0; f < F; ++f) {
        if (fn[f].dot(dir) < cosMax) continue;
        if (useBox) {
            Vec3 c = (m.p[m.t[f][0]] + m.p[m.t[f][1]] + m.p[m.t[f][2]]) * (1.0f / 3.0f);
            if (c.x < boxMin.x || c.y < boxMin.y || c.z < boxMin.z || c.x > boxMax.x || c.y > boxMax.y || c.z > boxMax.z) continue;
        }
        sel[f] = 1;
    }
    auto ef = edgeFaces(m);
    // Regions of selected faces connected by edges.
    std::vector<int> region(F, -1);
    int regions = 0;
    for (size_t s = 0; s < F; ++s) {
        if (!sel[s] || region[s] >= 0) continue;
        std::vector<uint32_t> stack{static_cast<uint32_t>(s)};
        region[s] = regions;
        while (!stack.empty()) {
            uint32_t f = stack.back(); stack.pop_back();
            for (int k = 0; k < 3; ++k)
                for (uint32_t g : ef.at(edgeKey(m.t[f][k], m.t[f][(k + 1) % 3])))
                    if (sel[g] && region[g] < 0) { region[g] = regions; stack.push_back(g); }
        }
        ++regions;
    }
    IndexedMesh out;
    out.p = m.p;
    for (size_t f = 0; f < F; ++f) if (!sel[f]) out.t.push_back(m.t[f]);
    for (int r = 0; r < regions; ++r) {
        Vec3 nR(0, 0, 0);
        std::vector<uint32_t> faces;
        for (size_t f = 0; f < F; ++f) if (region[f] == r) { faces.push_back(static_cast<uint32_t>(f)); nR += fn[f]; }
        nR = nR.normalized();
        // Border edges (directed as in the region's faces) and the region's vertices.
        std::vector<std::pair<uint32_t, uint32_t>> border;
        std::map<uint32_t, std::vector<Vec3>> inwardAt;
        for (uint32_t f : faces) for (int k = 0; k < 3; ++k) {
            uint32_t a = m.t[f][k], b = m.t[f][(k + 1) % 3];
            bool inner = false;
            for (uint32_t g : ef.at(edgeKey(a, b))) if (g != f && region[g] == r) inner = true;
            if (inner) continue;
            border.emplace_back(a, b);
            Vec3 d = (m.p[b] - m.p[a]).normalized();
            Vec3 in = nR.cross(d).normalized();  // left of a->b in a CCW face: towards the region
            inwardAt[a].push_back(in); inwardAt[b].push_back(in);
        }
        // Ring copies: border vertices inset within the region plane; then everything moved by depth.
        std::map<uint32_t, uint32_t> ring;
        for (auto& [v, ins] : inwardAt) {
            Vec3 d(0, 0, 0);
            if (ins.size() >= 2) {
                float c = ins[0].dot(ins[1]);
                d = (ins[0] + ins[1]) * (1.0f / std::max(0.2f, 1.0f + c));
            } else if (!ins.empty()) {
                d = ins[0];
            }
            ring[v] = static_cast<uint32_t>(out.p.size());
            out.p.push_back(m.p[v] + d * inset + nR * depth);
        }
        std::map<uint32_t, uint32_t> moved;
        auto top = [&](uint32_t v) -> uint32_t {
            auto it = ring.find(v);
            if (it != ring.end()) return it->second;
            auto mv = moved.find(v);
            if (mv != moved.end()) return mv->second;
            uint32_t idx = static_cast<uint32_t>(out.p.size());
            out.p.push_back(m.p[v] + nR * depth);
            moved[v] = idx;
            return idx;
        };
        for (uint32_t f : faces) out.t.push_back({top(m.t[f][0]), top(m.t[f][1]), top(m.t[f][2])});
        // Wall around the ring: original border edge (a->b) to its raised / inset copy.
        for (auto [a, b] : border) {
            uint32_t ta = ring[a], tb = ring[b];
            out.t.push_back({a, b, tb});
            out.t.push_back({a, tb, ta});
        }
    }
    return finish(out, input, name, smoothAngleDeg);
}

// --------------------------------------------------------------------------
// Solidify
// --------------------------------------------------------------------------
inline ScratchboxMesh solidify(const ScratchboxMesh& input, float thickness, float smoothAngleDeg = 30.0f, const std::string& name = "Solidified") {
    IndexedMesh m = weldForOps(input);
    const size_t V = m.p.size();
    std::vector<Vec3> vn(V, Vec3(0, 0, 0));
    for (size_t f = 0; f < m.t.size(); ++f) {
        const auto& t = m.t[f];
        for (int k = 0; k < 3; ++k) {
            Vec3 e1 = (m.p[t[(k + 1) % 3]] - m.p[t[k]]).normalized(), e2 = (m.p[t[(k + 2) % 3]] - m.p[t[k]]).normalized();
            float ang = std::acos(std::clamp(e1.dot(e2), -1.0f, 1.0f));
            vn[t[k]] += faceNormal(m, f) * ang;
        }
    }
    IndexedMesh out;
    out.p = m.p;
    for (size_t v = 0; v < V; ++v) {
        Vec3 n = vn[v].length() > 1e-12f ? vn[v].normalized() : Vec3(0, 1, 0);
        out.p.push_back(m.p[v] - n * thickness);
    }
    for (const auto& t : m.t) {
        out.t.push_back(t);
        out.t.push_back({t[0] + static_cast<uint32_t>(V), t[2] + static_cast<uint32_t>(V), t[1] + static_cast<uint32_t>(V)});
    }
    auto ef = edgeFaces(m);
    for (size_t f = 0; f < m.t.size(); ++f) for (int k = 0; k < 3; ++k) {
        uint32_t a = m.t[f][k], b = m.t[f][(k + 1) % 3];
        if (ef.at(edgeKey(a, b)).size() != 1) continue;
        // Open edge a->b: wall down to the inner copy, wound to continue the outer face across it.
        uint32_t ia = a + static_cast<uint32_t>(V), ib = b + static_cast<uint32_t>(V);
        out.t.push_back({b, a, ia});
        out.t.push_back({b, ia, ib});
    }
    return finish(out, input, name, smoothAngleDeg);
}

} // namespace meshops
} // namespace scratchbox

#endif // SCRATCHBOX_MESH_OPS_HPP
