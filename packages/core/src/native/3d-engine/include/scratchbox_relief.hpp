/********************************************************************************
 * Scratchbox Isoparametric Normal Relief
 *
 * The fourth universal operator: a designed height field h(p), in metres, applied to a mesh
 * by displacing its vertices along their smooth normals, after conformal red-green subdivision
 * wherever the field has detail (so a coarse box can carry fine panel lines). The field is a
 * sum of layers, each a continuous description, never a named category:
 *
 *   profile along carriers   a cross-section (width, depth, sharpness: 0 round .. 1 V, flat top
 *                            width) swept along polylines: shut lines, grooves (depth < 0), weld
 *                            beads and ribs (depth > 0), cable channels;
 *   periodic ridges          ridges of a pitch along a direction from an origin, with sharpness
 *                            and duty, plus an optional second direction (knurling, waffle);
 *   projected image          a height image projected onto the surface like a decal (centre,
 *                            normal, up, size), tiled a continuous number of times, scaled to a
 *                            depth: carved ornament, embossed lettering, scanned patterns.
 *
 * Every layer takes an optional box mask (with a feather) and a facing mask (surfaces within an
 * angle of a direction), both continuous.
 ********************************************************************************/

#ifndef SCRATCHBOX_RELIEF_HPP
#define SCRATCHBOX_RELIEF_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_mesh_ops.hpp"
#include <vector>
#include <array>
#include <map>
#include <set>
#include <unordered_map>
#include <cmath>
#include <algorithm>
#include <string>
#include <cstdint>

namespace scratchbox {
namespace relief {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using texture::ImageBuffer;

inline float smoothstep(float e0, float e1, float x) {
    float t = std::clamp((x - e0) / std::max(1e-9f, e1 - e0), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

// Cross-section of a profile: 1 at the centre line, 0 at half-width `w` away. sharpness 0 is a
// cosine bump, 1 a linear V; flatTop (0..1) is the fraction of the width that stays at full height.
inline float profileShape(float d, float w, float sharpness, float flatTop) {
    float a = std::abs(d) / std::max(1e-9f, w);
    if (a >= 1.0f) return 0.0f;
    float plateau = std::clamp(flatTop, 0.0f, 0.95f);
    float t = a <= plateau ? 0.0f : (a - plateau) / (1.0f - plateau);
    float round = 0.5f + 0.5f * std::cos(t * math::PI);
    float vee = 1.0f - t;
    float s = std::clamp(sharpness, 0.0f, 1.0f);
    return round * (1.0f - s) + vee * s;
}

struct Layer {
    // Shape: exactly one of the three is active, by which fields are set.
    std::vector<std::vector<Vec3>> carriers;  // profile along these polylines
    float widthM{0.01f};                      // half-width of the profile (distance from the centre line)
    float depthM{-0.002f};                    // height at the centre line; negative cuts in
    float sharpness{0.3f};
    float flatTop{0.0f};

    bool ridges{false};
    Vec3 ridgeOrigin{0, 0, 0};
    Vec3 ridgeDir{1, 0, 0};
    Vec3 ridgeDir2{0, 0, 0};                  // zero = single direction
    bool ridgeAroundAxis{false};              // cylindrical frame instead: s1/s2 are helices around ridgeDir
    float ridgeRadiusM{0.1f};                 // reference radius the pitch is measured at
    float helixDeg{0.0f};                     // helix angle; 0 = straight ridges along the axis
    float pitchM{0.002f};
    float ridgeDepthM{0.0005f};
    float ridgeSharpness{0.6f};
    float duty{0.5f};                         // fraction of each pitch that is ridge

    ImageBuffer image;                        // height from luminance x alpha
    Vec3 imageCentre{0, 0, 0};
    Vec3 imageNormal{0, 0, 1};
    Vec3 imageUp{0, 1, 0};
    float imageWidthM{0.2f};
    float imageHeightM{0.2f};
    float imageDepthM{0.002f};
    float imageTilesU{1.0f};
    float imageTilesV{1.0f};
    float imageProjectionDepthM{0.02f};       // how far from the image plane the projection reaches

    // Masks.
    bool hasBox{false};
    Vec3 boxMin{0, 0, 0}, boxMax{0, 0, 0};
    float featherM{0.0f};
    bool hasFacing{false};
    Vec3 facing{0, 1, 0};
    float facingMaxDeg{45.0f};
    float facingSoftDeg{15.0f};

    float strength{1.0f};
};

namespace detail {

inline float distanceToPolyline(const Vec3& p, const std::vector<Vec3>& pts) {
    float best = 1e30f;
    if (pts.size() == 1) return (p - pts[0]).length();
    for (size_t i = 0; i + 1 < pts.size(); ++i) {
        Vec3 a = pts[i], b = pts[i + 1], d = b - a;
        float len2 = d.dot(d);
        float t = len2 > 1e-20f ? std::clamp((p - a).dot(d) / len2, 0.0f, 1.0f) : 0.0f;
        best = std::min(best, (a + d * t - p).length());
    }
    return best;
}

inline float ridgeWave(float s, float pitch, float sharpness, float duty) {
    float u = s / std::max(1e-9f, pitch);
    u -= std::floor(u);                       // 0..1 across one pitch
    float half = std::clamp(duty, 0.02f, 0.98f) * 0.5f;
    float d = std::min(u, 1.0f - u);          // distance from the ridge centre at u = 0
    return profileShape(d, half, sharpness, 0.0f);
}

inline float maskWeight(const Layer& L, const Vec3& p, const Vec3& n) {
    float w = 1.0f;
    if (L.hasBox) {
        float inside = 1.0f;
        const float f = std::max(L.featherM, 0.0f);
        const float lo[3] = {L.boxMin.x, L.boxMin.y, L.boxMin.z}, hi[3] = {L.boxMax.x, L.boxMax.y, L.boxMax.z}, q[3] = {p.x, p.y, p.z};
        for (int k = 0; k < 3; ++k) {
            float dIn = std::min(q[k] - lo[k], hi[k] - q[k]);   // distance inside the slab (negative outside)
            inside *= f > 0.0f ? smoothstep(-f, 0.0f, dIn) : (dIn >= 0.0f ? 1.0f : 0.0f);
        }
        w *= inside;
    }
    if (L.hasFacing) {
        float cosA = n.dot(L.facing.normalized());
        float ang = std::acos(std::clamp(cosA, -1.0f, 1.0f)) * (180.0f / math::PI);
        w *= 1.0f - smoothstep(L.facingMaxDeg - L.facingSoftDeg, L.facingMaxDeg, ang);
    }
    return w * L.strength;
}

// Height of one layer at p (before masks). footprintM is the local mesh spacing: an image is averaged
// over it (a 5 x 5 box of bilinear taps), so hard image edges become ramps at mesh resolution instead
// of beating against the vertex lattice.
inline float layerHeight(const Layer& L, const Vec3& p, float footprintM = 0.0f) {
    if (!L.carriers.empty()) {
        float best = 1e30f;
        for (const auto& c : L.carriers) if (!c.empty()) best = std::min(best, distanceToPolyline(p, c));
        return L.depthM * profileShape(best, L.widthM, L.sharpness, L.flatTop);
    }
    if (L.ridges) {
        Vec3 rel = p - L.ridgeOrigin;
        if (L.ridgeAroundAxis) {
            // Arc length around the axis at the reference radius, with an integer number of ridges round
            // the circumference so the pattern closes on itself; helices cross at +-helixDeg.
            Vec3 a = L.ridgeDir.normalized();
            Vec3 b1 = std::abs(a.y) < 0.9f ? Vec3(0, 1, 0).cross(a).normalized() : Vec3(1, 0, 0).cross(a).normalized();
            Vec3 b2 = a.cross(b1);
            float y = rel.dot(a);
            Vec3 radial = rel - a * y;
            float theta = std::atan2(radial.dot(b2), radial.dot(b1));
            float circumference = math::TWO_PI * L.ridgeRadiusM;
            int count = std::max(1, static_cast<int>(std::lround(circumference / std::max(1e-6f, L.pitchM))));
            float pitch = circumference / count;
            float arc = theta * L.ridgeRadiusM;
            float ch = std::cos(L.helixDeg * math::DEG_TO_RAD), sh = std::sin(L.helixDeg * math::DEG_TO_RAD);
            float h = ridgeWave(arc * ch + y * sh, pitch, L.ridgeSharpness, L.duty);
            if (L.helixDeg != 0.0f || L.ridgeDir2.length() > 1e-6f) h *= ridgeWave(arc * ch - y * sh, pitch, L.ridgeSharpness, L.duty);
            return L.ridgeDepthM * h;
        }
        float h = ridgeWave(rel.dot(L.ridgeDir.normalized()), L.pitchM, L.ridgeSharpness, L.duty);
        if (L.ridgeDir2.length() > 1e-6f) {
            float h2 = ridgeWave(rel.dot(L.ridgeDir2.normalized()), L.pitchM, L.ridgeSharpness, L.duty);
            h = h * h2;                       // knurl: a diamond where both ridges cross
        }
        return L.ridgeDepthM * h;
    }
    if (!L.image.empty()) {
        Vec3 N = L.imageNormal.normalized();
        Vec3 R = L.imageUp.cross(N).normalized();
        Vec3 U = N.cross(R);
        Vec3 rel = p - L.imageCentre;
        if (std::abs(rel.dot(N)) > L.imageProjectionDepthM) return 0.0f;
        auto tap = [&](float u, float v) {
            if (u < 0.0f || u > 1.0f || v < 0.0f || v > 1.0f) return 0.0f;
            float tu = u * L.imageTilesU, tv = v * L.imageTilesV;
            tu -= std::floor(tu); tv -= std::floor(tv);
            Vec3 c = L.image.sampleBilinear(tu, tv);
            float lum = 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
            float alpha = 1.0f;
            if (L.image.channels == 4) {
                int x = std::clamp(static_cast<int>(tu * L.image.width), 0, L.image.width - 1);
                int y = std::clamp(static_cast<int>(tv * L.image.height), 0, L.image.height - 1);
                alpha = L.image.data[(static_cast<size_t>(y) * L.image.width + x) * 4 + 3] / 255.0f;
            }
            return lum * alpha;
        };
        float u = rel.dot(R) / L.imageWidthM + 0.5f, v = 0.5f - rel.dot(U) / L.imageHeightM;
        if (footprintM <= 0.0f) return L.imageDepthM * tap(u, v);
        float du = footprintM / L.imageWidthM, dv = footprintM / L.imageHeightM;
        float sum = 0.0f;
        for (int i = -2; i <= 2; ++i) for (int j = -2; j <= 2; ++j) sum += tap(u + du * i * 0.25f, v + dv * j * 0.25f);
        return L.imageDepthM * sum / 25.0f;
    }
    return 0.0f;
}

// Whether a layer can be non-zero within `margin` of p on a face with normal n (for deciding where to
// subdivide): outside the box, or facing away from a facing mask, it cannot.
inline bool layerReaches(const Layer& L, const Vec3& p, float margin, const Vec3& n = Vec3(0, 0, 0)) {
    if (L.hasFacing && n.length() > 0.5f) {
        float ang = std::acos(std::clamp(n.dot(L.facing.normalized()), -1.0f, 1.0f)) * (180.0f / math::PI);
        if (ang > L.facingMaxDeg + 15.0f) return false;   // slack for the smooth normals used at displacement
    }
    if (L.hasBox) {
        float f = std::max(L.featherM, 0.0f) + margin;
        if (p.x < L.boxMin.x - f || p.y < L.boxMin.y - f || p.z < L.boxMin.z - f ||
            p.x > L.boxMax.x + f || p.y > L.boxMax.y + f || p.z > L.boxMax.z + f) return false;
    }
    if (!L.carriers.empty()) {
        for (const auto& c : L.carriers) if (!c.empty() && distanceToPolyline(p, c) <= L.widthM + margin) return true;
        return false;
    }
    if (L.ridges) return true;
    if (!L.image.empty()) {
        Vec3 N = L.imageNormal.normalized();
        Vec3 R = L.imageUp.cross(N).normalized();
        Vec3 U = N.cross(R);
        Vec3 rel = p - L.imageCentre;
        return std::abs(rel.dot(N)) <= L.imageProjectionDepthM + margin &&
               std::abs(rel.dot(R)) <= L.imageWidthM * 0.5f + margin && std::abs(rel.dot(U)) <= L.imageHeightM * 0.5f + margin;
    }
    return false;
}

// The finest length scale a layer carries, so subdivision stops once edges resolve it.
inline float layerDetail(const Layer& L) {
    if (!L.carriers.empty()) return L.widthM * (L.flatTop > 0.0f ? (1.0f - L.flatTop) : 1.0f);
    if (L.ridges) return L.pitchM * std::clamp(L.duty, 0.02f, 0.98f);
    if (!L.image.empty()) {
        // Two image pixels: finer subdivision cannot show more than the image holds.
        float pxU = L.imageWidthM / std::max(1.0f, L.imageTilesU) / std::max(1, L.image.width);
        float pxV = L.imageHeightM / std::max(1.0f, L.imageTilesV) / std::max(1, L.image.height);
        return 2.0f * std::min(pxU, pxV);
    }
    return 1e30f;
}

} // namespace detail

/**
 * Applies the layers to a mesh. Triangles any layer reaches are split (conformally, 1->2, 1->3 or
 * 1->4) until their edges are at most `samplesPerDetail` times shorter than the layer's finest
 * detail or `targetEdgeM`, whichever is larger, up to maxSubdivisions rounds; then every vertex
 * moves along its smooth normal by the summed, masked height.
 */
inline ScratchboxMesh apply(const ScratchboxMesh& input, const std::vector<Layer>& layers, float targetEdgeM = 0.0f,
                            int maxSubdivisions = 6, float samplesPerDetail = 3.0f, float smoothAngleDeg = 30.0f,
                            const std::string& name = "Relief") {
    using namespace detail;
    meshops::IndexedMesh m = meshops::weldForOps(input);
    if (layers.empty() || m.t.empty()) return meshops::finish(m, input, name, smoothAngleDeg);

    float detail = 1e30f;
    for (const auto& L : layers) detail = std::min(detail, layerDetail(L));
    float target = std::max(targetEdgeM, detail / std::max(1.0f, samplesPerDetail));
    if (!(target > 1e-6f)) target = 1e-3f;

    // Red-green subdivision rounds.
    for (int round = 0; round < maxSubdivisions; ++round) {
        std::unordered_map<uint64_t, uint32_t> mid;
        // Mark edges of triangles that are too long and reached by a layer.
        std::vector<uint64_t> toSplit;
        for (const auto& t : m.t) {
            Vec3 c = (m.p[t[0]] + m.p[t[1]] + m.p[t[2]]) * (1.0f / 3.0f);
            float longest = 0.0f;
            for (int k = 0; k < 3; ++k) longest = std::max(longest, (m.p[t[k]] - m.p[t[(k + 1) % 3]]).length());
            if (longest <= target) continue;
            Vec3 fnorm = (m.p[t[1]] - m.p[t[0]]).cross(m.p[t[2]] - m.p[t[0]]);
            fnorm = fnorm.length() > 1e-20f ? fnorm.normalized() : Vec3(0, 0, 0);
            bool reached = false;
            for (const auto& L : layers) if (layerReaches(L, c, longest, fnorm)) { reached = true; break; }
            if (!reached) continue;
            for (int k = 0; k < 3; ++k) {
                if ((m.p[t[k]] - m.p[t[(k + 1) % 3]]).length() > target) toSplit.push_back(meshops::edgeKey(t[k], t[(k + 1) % 3]));
            }
        }
        if (toSplit.empty()) break;
        for (uint64_t k : toSplit) {
            if (mid.count(k)) continue;
            uint32_t a = static_cast<uint32_t>(k >> 32), b = static_cast<uint32_t>(k & 0xffffffffu);
            mid[k] = static_cast<uint32_t>(m.p.size());
            m.p.push_back((m.p[a] + m.p[b]) * 0.5f);
        }
        std::vector<std::array<uint32_t, 3>> next;
        next.reserve(m.t.size() * 2);
        for (const auto& t : m.t) {
            uint32_t e[3]; int count = 0;
            for (int k = 0; k < 3; ++k) {
                auto it = mid.find(meshops::edgeKey(t[k], t[(k + 1) % 3]));
                e[k] = it == mid.end() ? UINT32_MAX : it->second;
                if (e[k] != UINT32_MAX) ++count;
            }
            if (count == 0) { next.push_back(t); continue; }
            if (count == 3) {
                next.push_back({t[0], e[0], e[2]}); next.push_back({e[0], t[1], e[1]});
                next.push_back({e[2], e[1], t[2]}); next.push_back({e[0], e[1], e[2]});
                continue;
            }
            // Rotate so edge 0 (t0->t1) is split.
            int r = 0;
            while (e[r] == UINT32_MAX) ++r;
            uint32_t v0 = t[r], v1 = t[(r + 1) % 3], v2 = t[(r + 2) % 3];
            uint32_t m0 = e[r], m1 = e[(r + 1) % 3], m2 = e[(r + 2) % 3];
            if (count == 1) {
                next.push_back({v0, m0, v2}); next.push_back({m0, v1, v2});
            } else if (m1 != UINT32_MAX) {           // edges v0v1 and v1v2 split
                next.push_back({m0, v1, m1}); next.push_back({v0, m0, m1}); next.push_back({v0, m1, v2});
            } else {                                 // edges v0v1 and v2v0 split
                next.push_back({v0, m0, m2}); next.push_back({m0, v1, m2}); next.push_back({m2, v1, v2});
            }
        }
        m.t.swap(next);
    }

    // Isotropic remesh of the flat areas the layers reach. Subdivision of long thin triangles (a fan cap)
    // keeps their angles, and on such an anisotropic grid no flip helps, so the reached flat regions are
    // remeshed in place: Delaunay flips, collapses of edges under half the target, in-plane Laplacian
    // smoothing of interior vertices and midpoint splits of edges over 4/3 of it, a few rounds, with
    // region boundaries fixed. Flat regions need no projection, so this stays exact.
    {
        const float cosFlat = 0.99985f;
        auto faceN = [&](const std::array<uint32_t, 3>& t) {
            Vec3 n = (m.p[t[1]] - m.p[t[0]]).cross(m.p[t[2]] - m.p[t[0]]);
            float len = n.length();
            return len > 1e-20f ? n / len : Vec3(0, 0, 0);
        };
        auto reachedFace = [&](const std::array<uint32_t, 3>& t) {
            Vec3 c = (m.p[t[0]] + m.p[t[1]] + m.p[t[2]]) * (1.0f / 3.0f);
            float longest = 0.0f;
            for (int k = 0; k < 3; ++k) longest = std::max(longest, (m.p[t[k]] - m.p[t[(k + 1) % 3]]).length());
            Vec3 fnorm = faceN(t);
            for (const auto& L : layers) if (layerReaches(L, c, longest, fnorm)) return true;
            return false;
        };
        std::vector<char> active, interior;
        std::vector<Vec3> fn;
        std::unordered_map<uint64_t, std::vector<uint32_t>> ef;
        std::vector<std::vector<uint32_t>> vf;
        auto flatPair = [&](uint32_t f, uint32_t g) { return active[f] && active[g] && fn[f].dot(fn[g]) >= cosFlat && fn[f].length() > 0.5f; };
        // Active faces, adjacency and planar-interior vertices (every incident face flat with the others and
        // active); rebuilt after every phase that changes topology, so every phase runs every iteration.
        auto refresh = [&]() {
            active.assign(m.t.size(), 0);
            fn.assign(m.t.size(), Vec3(0, 0, 0));
            for (size_t f = 0; f < m.t.size(); ++f) { fn[f] = faceN(m.t[f]); active[f] = reachedFace(m.t[f]); }
            ef = meshops::edgeFaces(m);
            vf.assign(m.p.size(), {});
            for (uint32_t f = 0; f < m.t.size(); ++f) for (uint32_t v : m.t[f]) vf[v].push_back(f);
            interior.assign(m.p.size(), 0);
            for (uint32_t v = 0; v < m.p.size(); ++v) {
                if (vf[v].size() < 3) continue;
                bool ok = true;
                for (uint32_t f : vf[v]) if (!active[f] || fn[vf[v][0]].dot(fn[f]) < cosFlat) { ok = false; break; }
                interior[v] = ok;
            }
        };
        // Vertices that have come to share one exact position (a collapse to a midpoint later split again)
        // are merged and the zero-area triangles between them dropped.
        auto dedupe = [&]() {
            std::map<std::array<float, 3>, uint32_t> first;
            std::vector<uint32_t> remap(m.p.size());
            bool any = false;
            for (uint32_t v = 0; v < m.p.size(); ++v) {
                auto it = first.emplace(std::array<float, 3>{m.p[v].x, m.p[v].y, m.p[v].z}, v);
                remap[v] = it.first->second;
                if (!it.second) any = true;
            }
            if (!any) return;
            std::vector<std::array<uint32_t, 3>> kept;
            for (auto t : m.t) {
                for (auto& v : t) v = remap[v];
                if (t[0] != t[1] && t[1] != t[2] && t[0] != t[2]) kept.push_back(t);
            }
            m.t.swap(kept);
        };
        for (int iter = 0; iter < 10; ++iter) {
            refresh();
            // 1. Splits of long interior flat edges (both faces split along it: conformal).
            {
                std::unordered_map<uint64_t, uint32_t> mid;
                for (const auto& [k, fs] : ef) {
                    if (fs.size() != 2 || !flatPair(fs[0], fs[1])) continue;
                    uint32_t a = static_cast<uint32_t>(k >> 32), b = static_cast<uint32_t>(k & 0xffffffffu);
                    if ((m.p[a] - m.p[b]).length() <= target * 4.0f / 3.0f) continue;
                    mid[k] = static_cast<uint32_t>(m.p.size());
                    m.p.push_back((m.p[a] + m.p[b]) * 0.5f);
                }
                if (!mid.empty()) {
                    std::vector<std::array<uint32_t, 3>> next;
                    next.reserve(m.t.size() + mid.size() * 2);
                    for (const auto& t : m.t) {
                        uint32_t e[3]; int count = 0;
                        for (int k = 0; k < 3; ++k) { auto it = mid.find(meshops::edgeKey(t[k], t[(k + 1) % 3])); e[k] = it == mid.end() ? UINT32_MAX : it->second; if (e[k] != UINT32_MAX) ++count; }
                        if (count == 0) { next.push_back(t); continue; }
                        if (count == 3) { next.push_back({t[0], e[0], e[2]}); next.push_back({e[0], t[1], e[1]}); next.push_back({e[2], e[1], t[2]}); next.push_back({e[0], e[1], e[2]}); continue; }
                        int r = 0; while (e[r] == UINT32_MAX) ++r;
                        uint32_t v0 = t[r], v1 = t[(r + 1) % 3], v2 = t[(r + 2) % 3], m0 = e[r], m1 = e[(r + 1) % 3], m2 = e[(r + 2) % 3];
                        if (count == 1) { next.push_back({v0, m0, v2}); next.push_back({m0, v1, v2}); }
                        else if (m1 != UINT32_MAX) { next.push_back({m0, v1, m1}); next.push_back({v0, m0, m1}); next.push_back({v0, m1, v2}); }
                        else { next.push_back({v0, m0, m2}); next.push_back({m0, v1, m2}); next.push_back({m2, v1, v2}); }
                    }
                    m.t.swap(next);
                    refresh();
                }
            }
            // 2. Collapses of short interior flat edges (survivor: a boundary vertex if one end is, else the midpoint).
            {
                std::vector<char> deadF(m.t.size(), 0), touched(m.p.size(), 0);
                bool collapsed = false;
                for (const auto& [k, fs] : ef) {
                    if (fs.size() != 2 || !flatPair(fs[0], fs[1])) continue;
                    uint32_t a = static_cast<uint32_t>(k >> 32), b = static_cast<uint32_t>(k & 0xffffffffu);
                    if (touched[a] || touched[b] || (!interior[a] && !interior[b])) continue;
                    if ((m.p[a] - m.p[b]).length() >= target * 0.5f) continue;
                    if (!interior[a]) std::swap(a, b);           // a is the interior end that disappears
                    std::set<uint32_t> na, nb; std::vector<uint32_t> both;
                    for (uint32_t f : vf[a]) if (!deadF[f]) for (uint32_t v : m.t[f]) if (v != a) na.insert(v);
                    for (uint32_t f : vf[b]) if (!deadF[f]) for (uint32_t v : m.t[f]) if (v != b) nb.insert(v);
                    for (uint32_t f : vf[a]) if (!deadF[f] && (m.t[f][0] == b || m.t[f][1] == b || m.t[f][2] == b)) both.push_back(f);
                    if (both.size() != 2) continue;
                    size_t common = 0; for (uint32_t v : na) if (v != b && nb.count(v)) ++common;
                    if (common != 2) continue;
                    Vec3 target3 = interior[b] ? (m.p[a] + m.p[b]) * 0.5f : m.p[b];
                    bool flips = false;
                    for (uint32_t v : {a, b}) for (uint32_t f : vf[v]) {
                        if (deadF[f] || f == both[0] || f == both[1]) continue;
                        std::array<uint32_t, 3> t = m.t[f];
                        Vec3 P[3]; for (int q = 0; q < 3; ++q) P[q] = (t[q] == a || t[q] == b) ? target3 : m.p[t[q]];
                        Vec3 after = (P[1] - P[0]).cross(P[2] - P[0]);
                        if (after.dot(fn[f]) <= 1e-12f) { flips = true; break; }
                    }
                    if (flips) continue;
                    m.p[b] = target3;
                    for (uint32_t f : vf[a]) { if (deadF[f]) continue; for (auto& v : m.t[f]) if (v == a) v = b; }
                    deadF[both[0]] = deadF[both[1]] = 1;
                    for (uint32_t v : {a, b}) for (uint32_t f : vf[v]) if (!deadF[f]) for (uint32_t q : m.t[f]) touched[q] = 1;
                    collapsed = true;
                }
                if (collapsed) {
                    std::vector<std::array<uint32_t, 3>> kept;
                    for (size_t f = 0; f < m.t.size(); ++f) if (!deadF[f]) kept.push_back(m.t[f]);
                    m.t.swap(kept);
                    dedupe();
                    refresh();
                }
            }
            // 3. Delaunay flips on flat pairs (opposite angles sum over 180 degrees), new edge not yet present.
            {
                std::vector<char> touched(m.t.size(), 0);
                for (const auto& [k, fs] : ef) {
                    if (fs.size() != 2 || touched[fs[0]] || touched[fs[1]] || !flatPair(fs[0], fs[1])) continue;
                    uint32_t a = static_cast<uint32_t>(k >> 32), b = static_cast<uint32_t>(k & 0xffffffffu);
                    auto& t0 = m.t[fs[0]]; auto& t1 = m.t[fs[1]];
                    uint32_t c = t0[0] != a && t0[0] != b ? t0[0] : (t0[1] != a && t0[1] != b ? t0[1] : t0[2]);
                    uint32_t d = t1[0] != a && t1[0] != b ? t1[0] : (t1[1] != a && t1[1] != b ? t1[1] : t1[2]);
                    if (c == d || ef.count(meshops::edgeKey(c, d))) continue;
                    auto angleAt = [&](uint32_t o, uint32_t u, uint32_t w) {
                        Vec3 x = m.p[u] - m.p[o], y = m.p[w] - m.p[o];
                        return std::acos(std::clamp(x.dot(y) / std::max(1e-20f, x.length() * y.length()), -1.0f, 1.0f));
                    };
                    if (angleAt(c, a, b) + angleAt(d, a, b) <= math::PI + 1e-4f) continue;
                    // The new triangles keep t0's winding; both must face the way the pair faces (the quad is
                    // convex) with a real area, or the flip would fold the surface over itself or leave a sliver.
                    bool ab = false;
                    for (int i = 0; i < 3; ++i) if (t0[i] == a && t0[(i + 1) % 3] == b) ab = true;
                    std::array<uint32_t, 3> n0t = ab ? std::array<uint32_t, 3>{a, d, c} : std::array<uint32_t, 3>{a, c, d};
                    std::array<uint32_t, 3> n1t = ab ? std::array<uint32_t, 3>{b, c, d} : std::array<uint32_t, 3>{b, d, c};
                    Vec3 n0 = fn[fs[0]];
                    Vec3 na = (m.p[n0t[1]] - m.p[n0t[0]]).cross(m.p[n0t[2]] - m.p[n0t[0]]);
                    Vec3 nb = (m.p[n1t[1]] - m.p[n1t[0]]).cross(m.p[n1t[2]] - m.p[n1t[0]]);
                    const float minArea2 = 1e-4f * target * target;
                    if (na.dot(n0) <= minArea2 || nb.dot(n0) <= minArea2) continue;
                    t0 = n0t; t1 = n1t;
                    touched[fs[0]] = touched[fs[1]] = 1;
                }
            }
            refresh();
            // 4. Laplacian smoothing of planar-interior vertices (stays in the plane: all neighbours are in it).
            {
                std::vector<Vec3> np = m.p;
                std::vector<Vec3> sum(m.p.size(), Vec3(0, 0, 0));
                std::vector<int> cnt(m.p.size(), 0);
                for (const auto& t : m.t) for (int k = 0; k < 3; ++k) {
                    uint32_t u = t[k], w = t[(k + 1) % 3];
                    sum[u] += m.p[w]; ++cnt[u]; sum[w] += m.p[u]; ++cnt[w];
                }
                for (uint32_t v = 0; v < m.p.size(); ++v) if (interior[v] && cnt[v] > 0) np[v] = m.p[v] + (sum[v] / static_cast<float>(cnt[v]) - m.p[v]) * 0.5f;
                // Reject the move at any vertex where a surrounding face would flip.
                for (uint32_t v = 0; v < m.p.size(); ++v) {
                    if (!interior[v]) continue;
                    bool bad = false;
                    for (uint32_t f : vf[v]) {
                        const auto& t = m.t[f];
                        Vec3 P[3]; for (int q = 0; q < 3; ++q) P[q] = t[q] == v ? np[v] : m.p[t[q]];
                        if ((P[1] - P[0]).cross(P[2] - P[0]).dot(fn[f]) <= 1e-12f) { bad = true; break; }
                    }
                    if (bad) np[v] = m.p[v];
                }
                m.p.swap(np);
            }
        }
    }

    // Smooth normals and local spacing, then displacement.
    std::vector<Vec3> vn(m.p.size(), Vec3(0, 0, 0));
    std::vector<float> edgeSum(m.p.size(), 0.0f);
    std::vector<int> edgeCnt(m.p.size(), 0);
    for (const auto& t : m.t) {
        Vec3 n = (m.p[t[1]] - m.p[t[0]]).cross(m.p[t[2]] - m.p[t[0]]);
        for (int k = 0; k < 3; ++k) {
            vn[t[k]] += n;
            float l = (m.p[t[k]] - m.p[t[(k + 1) % 3]]).length();
            edgeSum[t[k]] += l; ++edgeCnt[t[k]]; edgeSum[t[(k + 1) % 3]] += l; ++edgeCnt[t[(k + 1) % 3]];
        }
    }
    for (size_t v = 0; v < m.p.size(); ++v) {
        Vec3 n = vn[v].length() > 1e-20f ? vn[v].normalized() : Vec3(0, 1, 0);
        // Two local edge lengths: a hard image edge then ramps over two rows of triangles, which shade as a
        // smooth wall; one row would put every wall vertex at an arbitrary ramp height and look serrated.
        float footprint = edgeCnt[v] ? 2.0f * edgeSum[v] / edgeCnt[v] : 0.0f;
        float h = 0.0f;
        for (const auto& L : layers) {
            float w = maskWeight(L, m.p[v], n);
            if (w <= 0.0f) continue;
            h += w * layerHeight(L, m.p[v], footprint);
        }
        if (h != 0.0f) m.p[v] = m.p[v] + n * h;
    }
    return meshops::finish(m, input, name, smoothAngleDeg);
}

} // namespace relief
} // namespace scratchbox

#endif // SCRATCHBOX_RELIEF_HPP
